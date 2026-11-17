declare function validate(data: unknown): boolean;
declare namespace validate {
  let errors: { instancePath: string; message?: string; params: Record<string, unknown> }[] | null;
}
export default validate;
