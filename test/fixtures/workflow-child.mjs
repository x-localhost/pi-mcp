import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workflow } from '../../src/workflow.mjs';
import { withOwnershipLock } from '../../src/ownership.mjs';

const [stateDir, goalId] = process.argv.slice(2);
const jobsFile = path.join(stateDir, 'fake-jobs.json');
const readJobs = async () => JSON.parse(await fs.readFile(jobsFile, 'utf8'));
const manager = {
  config: { stateDir },
  lock: run => withOwnershipLock(path.join(stateDir, 'submit.lock'), run),
  all: readJobs,
  read: async id => (await readJobs()).find(job => job.id === id),
  start: async input => manager.lock(async () => {
    const jobs = await readJobs();
    const existing = jobs.find(job => job.requestId === input.request_id);
    if (existing) return existing;
    await new Promise(resolve => setTimeout(resolve, 100));
    const job = { id: `task-${randomUUID()}`, requestId: input.request_id, status: 'running' };
    jobs.push(job);
    await fs.writeFile(jobsFile, JSON.stringify(jobs));
    return job;
  }),
};

const result = await new Workflow(manager).advance(goalId);
process.stdout.write(JSON.stringify(result) + '\n');
