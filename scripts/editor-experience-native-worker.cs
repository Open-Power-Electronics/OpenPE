// Test-only Windows worker. Its only injectable sequence is one move and four
// alternating wheel ticks. No buttons, keys, window activation or settings edits.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class OpenPENativeWheelWorker {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Value; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);

  public sealed class Observation {
    public long Foreground, PointerRoot, TargetRoot;
    public uint Pid, PointerPid, TargetPid, Dpi;
    public int Left, Top, Width, Height, CursorX, CursorY;
    public bool Visible, Minimized, Modified;
  }
  public sealed class Expected {
    public long Window; public uint Pid, Dpi;
    public int Left, Top, Width, Height, CursorX, CursorY;
    public double Ratio, CanvasLeft, CanvasTop, CanvasRight, CanvasBottom;
  }
  static Expected expected;
  static int nextInput, lastId, commandCount;
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=8192, RecursionLimit=8 };
  static double Now() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
  static void Require(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
  static Dictionary<string, object> Object(object value) {
    var map = value as Dictionary<string, object>;
    Require(map != null, "Expected a JSON object."); return map;
  }
  static void Keys(Dictionary<string, object> map, params string[] keys) {
    Require(map.Count == keys.Length, "Unexpected command fields.");
    foreach (string key in keys) Require(map.ContainsKey(key), "Missing command field: " + key);
  }
  static double Number(Dictionary<string, object> map, string key, double min, double max) {
    object value = map[key];
    Require(value is int || value is long || value is double || value is decimal, "Expected a JSON number: " + key);
    double result = Convert.ToDouble(value, CultureInfo.InvariantCulture);
    Require(!Double.IsNaN(result) && !Double.IsInfinity(result) && result >= min && result <= max,
      "Number outside allowed bounds: " + key); return result;
  }
  static int Integer(Dictionary<string, object> map, string key, int min, int max) {
    double value = Number(map, key, min, max); Require(Math.Floor(value) == value, "Expected integer: " + key); return (int)value;
  }
  static string Text(Dictionary<string, object> map, string key) {
    string value = map[key] as string; Require(value != null && value.Length <= 64, "Invalid command text."); return value;
  }
  public static bool AnyInterference(Func<int,short> readState) {
    foreach (int key in new int[] { 1,2,4,5,6,16,17,18,91,92 })
      if (readState(key) < 0) return true;
    return false;
  }
  static Observation Observe(long handle) {
    var window = new IntPtr(handle); var origin = new Point(); var rect = new Rect(); var cursor = new Point();
    Require(GetClientRect(window, out rect) && ClientToScreen(window, ref origin) && GetCursorPos(out cursor),
      "Could not observe owned window/client/cursor.");
    uint pid, pointerPid; GetWindowThreadProcessId(window, out pid);
    IntPtr pointer = WindowFromPoint(cursor); GetWindowThreadProcessId(pointer, out pointerPid);
    bool modified = AnyInterference(GetAsyncKeyState);
    var observation=new Observation { Foreground=GetForegroundWindow().ToInt64(), PointerRoot=GetAncestor(pointer, 2).ToInt64(),
      Pid=pid, PointerPid=pointerPid, Dpi=GetDpiForWindow(window), Left=origin.X, Top=origin.Y,
      Width=rect.Right-rect.Left, Height=rect.Bottom-rect.Top, CursorX=cursor.X, CursorY=cursor.Y,
      Visible=IsWindowVisible(window), Minimized=IsIconic(window), Modified=modified };
    if (targetSet) ObserveDestination(observation);
    return observation;
  }
  static void ObserveDestination(Observation actual) {
    IntPtr window=WindowFromPoint(new Point { X=targetX,Y=targetY }); uint pid;
    GetWindowThreadProcessId(window,out pid); actual.TargetRoot=GetAncestor(window,2).ToInt64(); actual.TargetPid=pid;
  }
  public static void ValidateGuard(Expected wanted, Observation actual, bool inCanvas, bool initialMove=false) {
    Require(actual.Foreground == wanted.Window && actual.Pid == wanted.Pid, "Owned window lost foreground/PID identity.");
    Require(actual.TargetRoot == wanted.Window && actual.TargetPid == wanted.Pid, "Destination is covered by another window/process.");
    if (!initialMove) Require(actual.PointerRoot == wanted.Window && actual.PointerPid == wanted.Pid, "Pointer is over another window/process.");
    Require(actual.Visible && !actual.Minimized && !actual.Modified, "Window unavailable or physical buttons/modifiers held.");
    Require(actual.Left == wanted.Left && actual.Top == wanted.Top && actual.Width == wanted.Width &&
      actual.Height == wanted.Height && actual.Dpi == wanted.Dpi, "Window client origin/size/DPI changed.");
    Require(actual.CursorX == wanted.CursorX && actual.CursorY == wanted.CursorY, "Pointer changed outside this worker.");
    if (!initialMove) Require(actual.CursorX >= wanted.Left && actual.CursorX < wanted.Left+wanted.Width &&
      actual.CursorY >= wanted.Top && actual.CursorY < wanted.Top+wanted.Height, "Pointer is outside the owned client.");
    if (inCanvas) Require(actual.CursorX >= wanted.CanvasLeft && actual.CursorX < wanted.CanvasRight &&
      actual.CursorY >= wanted.CanvasTop && actual.CursorY < wanted.CanvasBottom, "Pointer is outside the reviewed canvas.");
  }
  static object Initialize(Dictionary<string, object> map) {
    Keys(map, "id", "command", "hwnd", "pid", "width", "height", "ratio", "left", "top", "right", "bottom", "x", "y");
    Require(expected == null, "Worker may initialize only once.");
    long handle; Require(Int64.TryParse(Text(map,"hwnd"), NumberStyles.None, CultureInfo.InvariantCulture, out handle) && handle > 0,
      "Invalid owned HWND.");
    uint pid = (uint)Integer(map,"pid",1,Int32.MaxValue); double ratio=Number(map,"ratio",0.5,8);
    var actual = Observe(handle);
    expected = new Expected { Window=handle, Pid=pid, Dpi=actual.Dpi, Left=actual.Left, Top=actual.Top,
      Width=actual.Width, Height=actual.Height, CursorX=actual.CursorX, CursorY=actual.CursorY, Ratio=ratio };
    Require(Math.Abs(ratio-actual.Dpi/96.0) < 0.000001, "Renderer/device/window DPI ratios differ.");
    Require(Math.Abs(actual.Width-Number(map,"width",100,16384)*ratio) <= 1 &&
      Math.Abs(actual.Height-Number(map,"height",100,16384)*ratio) <= 1, "Renderer viewport does not match the native client.");
    double left=Number(map,"left",0,16384), top=Number(map,"top",0,16384);
    double right=Number(map,"right",0,16384), bottom=Number(map,"bottom",0,16384);
    double x=Number(map,"x",0,16384), y=Number(map,"y",0,16384);
    Require(right>left && bottom>top && x>left+8 && x<right-8 && y>top+8 && y<bottom-8,
      "Reviewed point must lie inside the canvas.");
    expected.CanvasLeft=actual.Left+left*ratio; expected.CanvasTop=actual.Top+top*ratio;
    expected.CanvasRight=actual.Left+right*ratio; expected.CanvasBottom=actual.Top+bottom*ratio;
    Require(expected.CanvasLeft>=actual.Left && expected.CanvasTop>=actual.Top &&
      expected.CanvasRight<=actual.Left+actual.Width+1 && expected.CanvasBottom<=actual.Top+actual.Height+1,
      "Canvas extends beyond the owned native client.");
    targetX=actual.Left+(int)Math.Round(x*ratio,MidpointRounding.AwayFromZero);
    targetY=actual.Top+(int)Math.Round(y*ratio,MidpointRounding.AwayFromZero);
    bool duplicatePositionOffset=targetX==actual.CursorX && targetY==actual.CursorY;
    if (duplicatePositionOffset) targetX++;
    Require(targetX>=expected.CanvasLeft && targetX<expected.CanvasRight &&
      targetY>=expected.CanvasTop && targetY<expected.CanvasBottom,"Quantized target escaped the reviewed canvas.");
    targetSet=true; ObserveDestination(actual); ValidateGuard(expected,actual,false,true);
    return new { observation=actual, targetX, targetY,
      clientX=(targetX-actual.Left)/ratio, clientY=(targetY-actual.Top)/ratio, ratio,duplicatePositionOffset };
  }
  static int targetX, targetY;
  static bool targetSet;
  public static int ValidateInputPlan(int index, string command) {
    Require(index>=0 && index<5 && command==(index==0 ? "move" : "wheel"),
      "Native command is outside the fixed five-input plan.");
    return index==0 ? 0 : index%2==1 ? -120 : 120;
  }
  public static void ValidateInsertedCount(uint count) { Require(count==1,"Win32 SendInput must insert exactly one event."); }
  static object Inject(Dictionary<string, object> map, string command) {
    Keys(map,"id","command"); Require(expected != null && nextInput < 5, "Unexpected native input count.");
    int wheelDelta=ValidateInputPlan(nextInput,command);
    ValidateGuard(expected,Observe(expected.Window),nextInput>0,nextInput==0);
    var value = new MouseInput();
    if (nextInput == 0) {
      int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
      Require(width>0 && height>0 && targetX>=left && targetX<left+width && targetY>=top && targetY<top+height,
        "Target is outside the virtual desktop.");
      value.X=(int)(((long)(targetX-left)*65536+32768)/width);
      value.Y=(int)(((long)(targetY-top)*65536+32768)/height);
      Require(value.X>=0 && value.X<=65535 && value.Y>=0 && value.Y<=65535, "Invalid absolute pointer coordinate.");
      value.Flags=0x0001|0x8000|0x4000|0x2000; // MOVE, ABSOLUTE, VIRTUALDESK, MOVE_NOCOALESCE
    } else { value.Data=unchecked((uint)wheelDelta); value.Flags=0x0800; }
    var inputs = new Input[] { new Input { Type=0, Value=new InputUnion { Mouse=value } } };
    double before=Now(); uint sent=SendInput(1,inputs,Marshal.SizeOf(typeof(Input))); double after=Now();
    ValidateInsertedCount(sent);
    if (nextInput == 0) { expected.CursorX=targetX; expected.CursorY=targetY; }
    var observation=Observe(expected.Window); ValidateGuard(expected,observation,true);
    int index=nextInput++;
    return new { inputIndex=index, type=index==0 ? "pointermove" : "wheel", wheelDelta, insertedCount=sent,
      clientX=(targetX-expected.Left)/expected.Ratio, clientY=(targetY-expected.Top)/expected.Ratio,
      qpcBeforeSendMs=before, qpcAfterSendMs=after, observation };
  }
  public static void Run() {
    Require(Stopwatch.IsHighResolution,"High-resolution QPC timing is unavailable.");
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      Require(previous != IntPtr.Zero,"Could not establish per-monitor native coordinates.");
      Console.WriteLine(json.Serialize(new { ready=true, pid=Process.GetCurrentProcess().Id, frequency=Stopwatch.Frequency, highResolution=true, qpcMs=Now() }));
      string line;
      while ((line=Console.ReadLine()) != null) {
        int id=0;
        try {
          Require(line.Length<=8192 && ++commandCount<=32,"Native protocol limit exceeded.");
          var map=Object(json.DeserializeObject(line)); id=Integer(map,"id",1,32);
          Require(id>lastId,"Duplicate/reordered native request."); lastId=id;
          string command=Text(map,"command"); object result;
          if (command=="init") result=Initialize(map);
          else if (command=="clock") { Keys(map,"id","command");
            if (expected!=null) ValidateGuard(expected,Observe(expected.Window),nextInput>0,nextInput==0);
            result=new { qpcMs=Now(), frequency=Stopwatch.Frequency }; }
          else if (command=="move" || command=="wheel") result=Inject(map,command);
          else if (command=="stop") { Keys(map,"id","command"); Console.WriteLine(json.Serialize(new { id, ok=true })); return; }
          else throw new InvalidOperationException("Unknown native input command.");
          Console.WriteLine(json.Serialize(new { id, ok=true, result }));
        } catch (Exception error) { Console.WriteLine(json.Serialize(new { id, ok=false, error=error.Message })); return; }
      }
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  public static void GuardTests() {
    var wanted=new Expected { Window=100, Pid=42, Dpi=120, Left=10,Top=20,Width=1000,Height=700,
      CursorX=200,CursorY=300, CanvasLeft=100,CanvasTop=100,CanvasRight=900,CanvasBottom=600 };
    Func<Observation> fresh=()=>new Observation { Foreground=100,PointerRoot=100,TargetRoot=100,TargetPid=42,Pid=42,PointerPid=42,Dpi=120,
      Left=10,Top=20,Width=1000,Height=700,CursorX=200,CursorY=300,Visible=true };
    ValidateGuard(wanted,fresh(),true); int rejected=0;
    Action<Observation>[] mutations=new Action<Observation>[] {
      o=>o.Foreground=101,o=>o.Pid=43,o=>o.PointerRoot=101,o=>o.PointerPid=43,o=>o.TargetRoot=101,o=>o.TargetPid=43,
      o=>o.Visible=false,o=>o.Minimized=true,o=>o.Modified=true,o=>o.Left++,o=>o.Top++,
      o=>o.Width++,o=>o.Height++,o=>o.Dpi=96,o=>o.CursorX++,o=>o.CursorY++ };
    foreach (var mutate in mutations) { var observation=fresh(); mutate(observation);
      try { ValidateGuard(wanted,observation,true); } catch (InvalidOperationException) { rejected++; } }
    Require(rejected==mutations.Length,"A native ownership/foreground/DPI/cursor guard did not reject.");
    var outside=fresh(); wanted.CursorX=50; outside.CursorX=50;
    try { ValidateGuard(wanted,outside,true); throw new Exception("Canvas guard accepted outside pointer."); } catch (InvalidOperationException) {}
    bool badKeys=false; try { Keys(new Dictionary<string,object> { {"id",1},{"command","wheel"},{"path","unexpected"} },"id","command"); }
    catch (InvalidOperationException) { badKeys=true; } Require(badKeys,"Unexpected JSON fields accepted.");
    int[] plan=new int[] { 0,-120,120,-120,120 };
    for (int index=0;index<5;index++) Require(ValidateInputPlan(index,index==0 ? "move" : "wheel")==plan[index],"Wrong wheel plan.");
    foreach (int index in new int[] { -1,5,6 }) {
      bool rejectedPlan=false; try { ValidateInputPlan(index,"wheel"); } catch(InvalidOperationException) { rejectedPlan=true; }
      Require(rejectedPlan,"Unbounded native plan accepted.");
    }
    bool wrongMove=false; try { ValidateInputPlan(1,"move"); } catch(InvalidOperationException) { wrongMove=true; }
    Require(wrongMove,"Repeated native move accepted.");
    var initialOutside=fresh(); initialOutside.PointerRoot=999; initialOutside.PointerPid=99;
    initialOutside.CursorX=-100; wanted.CursorX=-100; ValidateGuard(wanted,initialOutside,false,true);
    bool blockedDestination=false; initialOutside.TargetRoot=999;
    try { ValidateGuard(wanted,initialOutside,false,true); } catch(InvalidOperationException) { blockedDestination=true; }
    Require(blockedDestination,"Initial move accepted a destination outside the owned window.");
    foreach (int pressed in new int[] { 1,2,4,5,6,16,17,18,91,92 })
      Require(AnyInterference(key=>key==pressed ? (short)-32768 : (short)0),"Held physical button/modifier was not detected.");
    initialOutside.TargetRoot=100; initialOutside.Modified=true;
    bool heldInitial=false; try { ValidateGuard(wanted,initialOutside,false,true); } catch(InvalidOperationException) { heldInitial=true; }
    Require(heldInitial,"Initial move accepted a held physical button.");
    ValidateInsertedCount(1);
    foreach (uint sent in new uint[] { 0,2 }) { bool rejectedCount=false;
      try { ValidateInsertedCount(sent); } catch(InvalidOperationException) { rejectedCount=true; }
      Require(rejectedCount,"Incorrect SendInput count accepted.");
    }
    Console.WriteLine("PASS native worker guard tests (no Win32 observation or input calls)");
  }
}
