import { describe, expect, it } from 'vitest';
import { MemoryGateLock } from '../src/policy/lock.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('MemoryGateLock', () => {
  it('runs critical sections for one household one at a time, in call order', async () => {
    const lock = new MemoryGateLock();
    const log: string[] = [];
    const job = (name: string) =>
      lock.run('hh_1', async () => {
        log.push(`${name}:in`);
        await tick();
        log.push(`${name}:out`);
        return name;
      });
    expect(await Promise.all([job('a'), job('b'), job('c')])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
    expect(lock.busy).toBe(0);
  });

  it('does not serialise different households', async () => {
    const lock = new MemoryGateLock();
    const log: string[] = [];
    const job = (hh: string) =>
      lock.run(hh, async () => {
        log.push(`${hh}:in`);
        await tick();
        log.push(`${hh}:out`);
      });
    await Promise.all([job('x'), job('y')]);
    expect(log.slice(0, 2).sort()).toEqual(['x:in', 'y:in']);
  });

  it('releases the lock when a critical section throws', async () => {
    const lock = new MemoryGateLock();
    const failed = lock.run('hh_1', async () => {
      throw new Error('boom');
    });
    const next = lock.run('hh_1', async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ran');
    expect(lock.busy).toBe(0);
  });
});
