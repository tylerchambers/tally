import manifest from "../package.json";

if (`bun@${Bun.version}` !== manifest.packageManager) {
  throw new Error(
    `Expected ${manifest.packageManager}; run mise install and mise exec -- bun run check`,
  );
}
