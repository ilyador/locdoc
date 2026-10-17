import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("bounded Node preserves a stricter kernel limit and rejects native buffer growth", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'ulimit -c 0; ulimit -S -d 131072; ulimit -H -d 131072; exec bash scripts/test-node.sh --jitless -e "$1"',
      "memory-limit-check",
      `
        const {readFileSync} = require('node:fs');
        const limits = /Max data size\\s+(\\d+)\\s+(\\d+)/.exec(readFileSync('/proc/self/limits', 'utf8'));
        const buffers = [];
        let failure = '';
        try {
          for (let i = 0; i < 32; i++) buffers.push(Buffer.alloc(8 * 1024 * 1024, 1));
        } catch (error) { failure = error.name; }
        console.log(JSON.stringify({soft: Number(limits[1]), hard: Number(limits[2]), failure, blocks: buffers.length}));
      `,
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 16384 },
  );
  assert.equal(result.status, 0, result.stderr.slice(0, 500));
  const report = JSON.parse(result.stdout);
  assert.equal(report.soft, 128 * 1024 * 1024);
  assert.equal(report.hard, 128 * 1024 * 1024);
  assert.equal(report.failure, "RangeError");
  assert.ok(
    report.blocks < 32,
    "Native allocations must stop at the kernel limit.",
  );
});
