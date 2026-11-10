/** Register a private-fixture test without reading private files when unavailable. */
export function privateFixture(name: string, fn: (home: string) => void | Promise<void>): void {
  const home = "fixtures/private/herdr-home";
  let present: boolean;
  try {
    present = Deno.statSync(home).isDirectory;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    present = false;
  }
  Deno.test({ name, ignore: !present, fn: () => fn(home) });
}
