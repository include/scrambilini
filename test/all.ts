/*
 * Runs the whole local suite in separate processes, stopping at the first
 * failure.
 *
 *   bun run test          (or: bun run test/all.ts)
 */
const TESTS = ['navtiming', 'coherence', 'attributes', 'reseed', 'popup', 'locks', 'amiunique'];

for (const name of TESTS) {
  console.log(`\n=== ${name} ===`);
  const proc = Bun.spawn(['bun', 'run', `test/${name}.ts`], {
    cwd: `${import.meta.dir}/..`,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n${name} failed (exit ${code})`);
    process.exit(code);
  }
}
console.log('\nall tests passed');
