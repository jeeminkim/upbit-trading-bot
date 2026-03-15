/**
 * 단일 인스턴스 lock: JSON 기반, stale 감지, PM2 재시작 루프 방지
 * - lock 파일에 pid, hostname, cwd, appName, createdAt, updatedAt 저장
 * - PID가 죽었거나 lock이 오래되면 stale로 제거 후 진행
 * - 실제 다른 인스턴스가 살아있을 때만 시작 거부
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCK_APP_NAME = 'server';
const STALE_AGE_MS = 120000; // 2분 이상 된 lock은 stale 후보

let ourLockPid = null;

function isPidAlive(pid) {
  if (pid == null || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} lockPath - full path to .server.lock
 * @returns {{ acquired: boolean, reason?: string, existingPid?: number, existingCwd?: string }}
 */
function tryAcquire(lockPath) {
  const cwd = process.cwd();
  const hostname = os.hostname();
  const pid = process.pid;
  const now = Date.now();

  if (!fs.existsSync(lockPath)) {
    writeLock(lockPath, { pid, hostname, cwd, appName: LOCK_APP_NAME, createdAt: now, updatedAt: now });
    ourLockPid = pid;
    return { acquired: true };
  }

  const existing = readLock(lockPath);
  if (!existing) {
    try { fs.unlinkSync(lockPath); } catch (_) {}
    writeLock(lockPath, { pid, hostname, cwd, appName: LOCK_APP_NAME, createdAt: now, updatedAt: now });
    ourLockPid = pid;
    return { acquired: true };
  }

  const existingPid = typeof existing.pid === 'number' ? existing.pid : parseInt(existing.pid, 10);
  const existingCwd = existing.cwd || '';
  const updatedAt = typeof existing.updatedAt === 'number' ? existing.updatedAt : (existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0);
  const age = now - updatedAt;

  if (!isPidAlive(existingPid) || age > STALE_AGE_MS) {
    console.warn('[server] Stale .server.lock detected. Removing stale lock and continuing startup.', {
      existingPid,
      existingCwd: existingCwd.slice(0, 80),
      ageMs: age,
      lockFile: lockPath,
    });
    try { fs.unlinkSync(lockPath); } catch (_) {}
    writeLock(lockPath, { pid, hostname, cwd, appName: LOCK_APP_NAME, createdAt: now, updatedAt: now });
    ourLockPid = pid;
    return { acquired: true };
  }

  if (existingCwd && existingCwd !== cwd) {
    return { acquired: false, reason: 'another_cwd', existingPid, existingCwd };
  }

  return { acquired: false, reason: 'active_instance', existingPid, existingCwd };
}

function writeLock(lockPath, data) {
  fs.writeFileSync(lockPath, JSON.stringify({ ...data, updatedAt: Date.now() }), 'utf8');
}

/**
 * 자기 프로세스가 쓴 lock만 제거
 */
function release(lockPath) {
  if (ourLockPid == null || ourLockPid !== process.pid) return;
  try {
    if (fs.existsSync(lockPath)) {
      const existing = readLock(lockPath);
      const existingPid = existing && (typeof existing.pid === 'number' ? existing.pid : parseInt(existing.pid, 10));
      if (existingPid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (_) {}
  ourLockPid = null;
}

module.exports = {
  tryAcquire,
  release,
  getOurLockPid: () => ourLockPid,
  LOCK_APP_NAME,
  STALE_AGE_MS,
};
