// Durable delivery for contact results. The worker writes the answer to disk
// before trying the hub, then retries it after network or hub restarts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultOutboxDir = path.join(os.homedir(), '.contact-research-outbox');

export function createContactOutbox({ dir = defaultOutboxDir, post, log = () => {} }) {
  let replaying = false;
  const fileFor = (jobId) => path.join(dir, `${jobId}.json`);

  function save(receipt) {
    if (!/^[a-f0-9]{12}$/.test(receipt.jobId)) throw new Error('invalid contact job id');
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(receipt.jobId);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(receipt));
    fs.renameSync(temp, file);
    return file;
  }

  async function send(receipt, file) {
    await post(receipt);
    fs.rmSync(file, { force: true });
  }

  async function deliver(receipt) {
    const file = save(receipt);
    try {
      await send(receipt, file);
      return { saved: true, queued: false };
    } catch (error) {
      log(`contact result ${receipt.jobId} saved in outbox; delivery will retry: ${error.message}`);
      return { saved: true, queued: true };
    }
  }

  async function replay() {
    if (replaying || !fs.existsSync(dir)) return 0;
    replaying = true;
    let delivered = 0;
    try {
      for (const name of fs.readdirSync(dir).filter((item) => /^[a-f0-9]{12}\.json$/.test(item))) {
        const file = path.join(dir, name);
        try {
          const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
          await send(receipt, file);
          delivered++;
        } catch (error) {
          log(`contact result ${name} is still in outbox: ${error.message}`);
        }
      }
      return delivered;
    } finally {
      replaying = false;
    }
  }

  return { deliver, replay };
}
