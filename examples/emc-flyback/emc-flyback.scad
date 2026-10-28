// OpenPE EMC Flyback enclosure: editable construction source.
// Native source: examples/emc-flyback/emc-flyback.kicad_pro, OPENPE_MODEL_CAD.
// Pinned upstream example: Chengmin Li and AI-PCB-layout contributors, CC BY 4.0.
// https://github.com/ChengminLi/AI-PCB-layout/tree/e1b9a64ac9ac306647fa30094932fb792d17e373/examples/emc-flyback-demo
// Manufacturer STEP models retain their separate source and licence terms.
// Units: millimetres. Native PCB X/Y axes; Z = 0 is the PCB mid-plane.
// Positions are panel centres; hole XY is local and each cut follows local Z.
// Base holes mount the PCB; cover holes are the four cover fasteners.

$fn = 96;
cut_margin_mm = 0.1;
aluminium_rgb = [0.749, 0.765, 0.776];
pmma_rgb = [0.863, 0.925, 0.937];

// Aluminium base; hole entries are [local X, local Y, diameter] in mm.
base_size = [112,94,3];
base_position = [100,88,-10.3];
base_holes = [[-46.2,-34.2,3.2],[46.2,34.2,3.2],[46.2,-34.2,3.2],[-46.2,34.2,3.2]];
base_opacity = 1;

// Aluminium front wall; hole entries are [local X, local Y, diameter] in mm.
front_wall_size = [112,3,30];
front_wall_position = [100,42.5,6.2];
front_wall_holes = [];
front_wall_opacity = 1;

// Aluminium back wall; hole entries are [local X, local Y, diameter] in mm.
back_wall_size = [112,3,30];
back_wall_position = [100,133.5,6.2];
back_wall_holes = [];
back_wall_opacity = 1;

// Transparent cover; hole entries are [local X, local Y, diameter] in mm.
cover_size = [112,94,3];
cover_position = [100,88,22.7];
cover_holes = [[-48,-41,3.2],[-48,41,3.2],[48,-41,3.2],[48,41,3.2]];
cover_opacity = 0.3;

module drilled_panel(dimensions, hole_pattern) {
  difference() {
    cube(dimensions, center = true);
    for (hole = hole_pattern)
      translate([hole[0], hole[1], 0])
        cylinder(h = dimensions[2] + 2 * cut_margin_mm, d = hole[2], center = true);
  }
}

module base_panel() {
  color(concat(aluminium_rgb, [base_opacity]))
    translate(base_position)
      drilled_panel(base_size, base_holes);
}

module front_wall_panel() {
  color(concat(aluminium_rgb, [front_wall_opacity]))
    translate(front_wall_position)
      drilled_panel(front_wall_size, front_wall_holes);
}

module back_wall_panel() {
  color(concat(aluminium_rgb, [back_wall_opacity]))
    translate(back_wall_position)
      drilled_panel(back_wall_size, back_wall_holes);
}

module cover_panel() {
  color(concat(pmma_rgb, [cover_opacity]))
    translate(cover_position)
      drilled_panel(cover_size, cover_holes);
}

module emc_flyback_enclosure() {
  base_panel();
  front_wall_panel();
  back_wall_panel();
  cover_panel();
}

emc_flyback_enclosure();
