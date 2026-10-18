import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Monitor } from "../server/monitor.js";
import { Configuration } from "../server/settings.js";
import { ChecksSchema } from "../server/check-config.js";

// Reuses the independent audit's actual scheduler/native-HTTP reproduction.
// The target must keep running and finish HTTP 200 while the monitor cannot run.
for (const suspension of [false, true]) {
  test(
    `VR-001 independent target during ${suspension ? "SIGSTOP/SIGCONT with active incident" : "20s event-loop stall"}`,
    { timeout: 85000 },
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "hb-pause-"));
      const target = spawn(
        process.execPath,
        [
          "-e",
          `
      const http=require('http'); let count=0;
      http.createServer((req,res)=>{
        if(++count<3){ res.statusCode=503;res.end('failed');return; }
        if(count===3){
          process.send({third:true});
          ${suspension ? `process.kill(${process.pid}, 'SIGSTOP');setTimeout(()=>process.kill(${process.pid}, 'SIGCONT'),20000);` : ""}
          setTimeout(()=>{res.end('healthy');res.once('finish',()=>process.send({healthyAt:Date.now()}));},100);
        }else res.end('healthy');
      }).listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});
    `,
        ],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      const [first] = (await once(target, "message")) as [{ port: number }];
      let pausedAt = 0,
        resumedAt = 0,
        healthyAt = 0;
      target.on(
        "message",
        (message: { third?: boolean; healthyAt?: number }) => {
          if (message.third) {
            pausedAt = Date.now();
            if (!suspension)
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                20000,
              );
            resumedAt = Date.now();
          }
          if (message.healthyAt) healthyAt = message.healthyAt;
        },
      );
      const config = ChecksSchema.parse({
        checks: [
          {
            id: "pause",
            name: "Independent pause",
            hostId: "h",
            type: "http",
            url: `http://127.0.0.1:${first.port}`,
            intervalSeconds: 10,
            timeoutMs: 9000,
            failureThreshold: 3,
            cooldownSeconds: 0,
          },
        ],
      });
      const store = new Configuration(
        path.join(directory, "monitor.sqlite"),
        config,
      );
      const sent: string[] = [];
      const monitor = new Monitor(store.runtime(), store.db, {
        provider: "fixture",
        send: async (message) => {
          sent.push(message.subject);
        },
      });
      const check = config.checks[0];
      if (suspension) {
        const now = Date.now() / 1000;
        for (let i = 0; i < 3; i++)
          monitor.record(
            check,
            { ok: false, responseMs: 1, reason: "HTTP 503" },
            now - 50 + i * 10,
          );
      }
      const prior = monitor.view().incidents[0]?.id;
      const until = async (condition: () => boolean) => {
        const deadline = Date.now() + 70000;
        while (!condition()) {
          assert(Date.now() < deadline, "scheduler observation deadline");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      try {
        monitor.start();
        await until(
          () =>
            !!store.db
              .prepare("SELECT 1 FROM samples WHERE ok IS NULL")
              .get() && healthyAt > 0,
        );
        // SIGSTOP can delay delivery of the IPC event itself. The independently
        // timestamped successful response still precedes the resumed observation.
        const completed =
          Number(
            store.db.prepare("SELECT max(checked) t FROM checks").get()?.t,
          ) * 1000;
        assert(
          healthyAt < Date.now() - 15000,
          "target actually returned HTTP 200 during the 20-second interruption",
        );
        if (!suspension) assert(healthyAt >= pausedAt && healthyAt < resumedAt);
        assert.equal(monitor.healthy(), false);
        assert.equal(monitor.view().checks[0].failures, 0);
        assert.equal(monitor.view().checks[0].state, "unknown");
        assert.equal(
          store.db.prepare("SELECT count(*) n FROM samples WHERE ok=1").get()
            ?.n,
          0,
          "no invented successful observation",
        );
        assert.equal(monitor.view().incidents.length, suspension ? 1 : 0);
        if (suspension) {
          assert.equal(monitor.view().activeIncidents?.[0].id, prior);
          assert.equal(monitor.view().activeIncidents?.[0].monitoringGap, true);
        }
        assert(healthyAt < Math.max(completed, Date.now()));
        await until(() => monitor.healthy());
        assert.equal(monitor.view().activeIncidents?.length, 0);
        if (suspension) {
          const incident = monitor.view().incidents[0];
          assert.equal(incident.id, prior);
          assert.equal(incident.resolution, "Reachability restored");
          await monitor.dispatch();
          assert.deepEqual(
            incident.notifications.map((n) => n.event),
            ["outage", "recovery"],
          );
          assert.equal(sent.length, 2);
        } else assert.equal(sent.length, 0);
      } finally {
        monitor.stop();
        target.kill();
        await once(target, "exit");
        store.db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
