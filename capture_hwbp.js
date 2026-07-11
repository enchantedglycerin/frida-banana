'use strict';
// Hardware-breakpoint capture: NO .text patch (no CRC trip). One-shot capture of
// libgame.so sub_15EDD20(key=x0, mode=x1, nonce=x2, counter=x3, data=x4, len=x5).
// Race the ~12s maps-scan death: grab the startup .djb decrypt keystream.
// keystream = data_in (at entry) XOR data_out (at return), over `len` bytes.
//
// Ownership & failure model:
//   * Assumes EXCLUSIVE use of ARM64 hardware debug slots 0 (entry) and 1 (return). Frida has
//     no slot-occupancy query, so if another debugger shares the process and uses these slots,
//     setHardwareBreakpoint may overwrite them. Guarantee: we never consume a breakpoint
//     EXCEPTION we did not originate — unrecognised ones pass through untouched.
//   * State transitions are gated on the triggering breakpoint being CONFIRMED cleared, with
//     ONE deliberate exception: on a SUCCESSFUL exit the capture data is already in hand, so
//     that exit-slot clear is best-effort (a failure is absorbed by the owned-aware quiescent
//     handler). Every other transition — including a failed-read discard — is gated.
//   * clearBp drops ownership only on a real unset success (or dead thread); on failure it
//     keeps ownership, ticks a bounded counter, and bail()s at the limit (irrecoverable unset
//     => explicit unhandled-breakpoint failure, not a retrap loop).
//   * Bounded failure accounting for BOTH slots: total inability to arm slot 0, and repeated
//     failure to install slot 1, each bail() after a limit. Reads are validated (bad entry read
//     abandons; bad exit read discards+retries). A capture that never returns (longjmp/unwind)
//     is released by a watchdog. Thread death is reaped via a thread observer (+ lazy reconcile).
var OFF_CIPHER = 0x15EDD20;
var CAP = 256;                 // upper bound on bytes we snapshot from the buffer
var RESIDUAL_TTL = 2000;       // ms a removed-bp snapshot stays eligible for a latched hit
var MAX_CLEAR_FAILS = 64;      // bail after this many failed unsets
var MAX_ARM_FAILS = 12;        // ~5s of totally-failed slot-0 arm cycles -> surface + bail
var MAX_RET_FAILS = 12;        // consecutive slot-1 (return bp) install failures -> surface + bail
var CAPTURE_TIMEOUT = 5000;    // ms to wait for a locked call's return before abandoning it

var addr = null;               // absolute entry address of the cipher
var pend = null;               // capture state between entry and its return
var finished = false;          // successful capture complete
var bailed = false;            // gave up after repeated hardware-breakpoint failures
var armInterval = null;        // setInterval handle for (re)arming entry bp
var captureWatchdog = null;    // setTimeout handle guarding a locked-but-unreturned call
var owned = {};                // tid -> {0: NativePointer|null, 1: NativePointer|null}
var residual = [];             // {tid, slot, addr, exp} consume-once snapshot of removed bps
var skips = 0;                 // count of skipped len<=0 calls (throttled log)
var clearFails = 0;            // running count of failed unsets
var armFails = 0;              // consecutive fully-failed slot-0 arm cycles
var retFails = 0;              // consecutive slot-1 (return bp) install failures

function hx(p, n){
  if (!p || n <= 0) return '';
  try { return Array.from(new Uint8Array(p.readByteArray(n)))
      .map(function(b){ return ('0'+b.toString(16)).slice(-2); }).join(''); }
  catch (e) { return '<e>'; }
}
function ok(s){ return s.length > 0 && s !== '<e>'; }      // a real read of >0 bytes
function threads(){ return Process.enumerateThreads(); }
function tobj(id){ var r = null; threads().forEach(function(t){ if (t.id === id) r = t; }); return r; }
function threadMap(){ var m = {}; threads().forEach(function(t){ m[t.id] = t; }); return m; }

function oget(tid){ var o = owned[tid]; if (!o){ o = { 0: null, 1: null }; owned[tid] = o; } return o; }
function ownsAt(tid, slot, pc){ var o = owned[tid]; return !!(o && o[slot] && o[slot].equals(pc)); }

// Reap all state for a thread that has terminated: prevents `owned` growth across churn and,
// crucially, stops TID reuse from making a fresh thread look already-armed (or getting slot 0
// unset by a later disarm even though we never set it there).
function reapThread(tid){
  delete owned[tid];
  for (var i = residual.length - 1; i >= 0; i--){ if (residual[i].tid === tid) residual.splice(i, 1); }
  if (pend && pend.tid === tid){
    console.log('[!] captured thread ' + tid + ' exited before return — re-arming');
    clearWatchdog(); pend = null;
    if (!finished && !bailed && !armInterval) armInterval = setInterval(arm, 400);
  }
}

// t (resolved Thread) is optional; passing it avoids a full thread re-enumeration per call.
function setBp(tid, slot, address, t){
  t = t || tobj(tid); if (!t) return false;
  try { t.setHardwareBreakpoint(slot, address); } catch (e) { return false; }
  oget(tid)[slot] = address; return true;
}
// Clear a bp we own. Drop ownership ONLY on a real success (or dead thread). On a genuine
// failure while the thread still exists, KEEP ownership, tick the counter (bailing if it runs
// away), and return false so the caller does NOT advance state.
function clearBp(tid, slot, t){
  var o = owned[tid];
  if (!o || !o[slot]) return true;                 // nothing owned here
  t = t || tobj(tid);
  if (!t){ o[slot] = null; if (!o[0] && !o[1]) delete owned[tid]; return true; }   // thread gone
  try { t.unsetHardwareBreakpoint(slot); }
  catch (e) { if (++clearFails >= MAX_CLEAR_FAILS) bail(); return false; }
  o[slot] = null; if (!o[0] && !o[1]) delete owned[tid];
  return true;
}
// Install a slot-1 (return) breakpoint with bounded failure accounting shared by the real-call
// exit bp and the skip-return bp — both compete for the single slot 1.
function setReturnBp(tid, lr, t){
  if (setBp(tid, 1, lr, t)){ retFails = 0; return true; }
  if (++retFails >= MAX_RET_FAILS){ console.log('[!] return breakpoint (slot 1) unavailable after ' + retFails + ' attempts'); bail(); }
  return false;
}

function residualPush(tid, slot, address){
  if (address) residual.push({ tid: tid, slot: slot, addr: address, exp: Date.now() + RESIDUAL_TTL });
}
function pruneResidual(now){
  for (var i = residual.length - 1; i >= 0; i--){ if (residual[i].exp < now) residual.splice(i, 1); }
}
function residualPending(tid){          // caller prunes first (arm); tests membership only
  for (var i = 0; i < residual.length; i++){ if (residual[i].tid === tid) return true; }
  return false;
}
// Consume at most one exact (tid, pc) snapshot match; prune expired first. The bp this entry
// represents was ALREADY removed, so do NOT clearBp here (that could wipe a newer slot re-armed
// at the same address) — just drop the snapshot and report handled.
function residualConsume(tid, pc){
  pruneResidual(Date.now());
  for (var j = 0; j < residual.length; j++){
    if (residual[j].tid === tid && residual[j].addr.equals(pc)){ residual.splice(j, 1); return true; }
  }
  return false;
}
// A hit on a slot we STILL own (a disarm couldn't remove it) or a removed-bp snapshot. For a
// still-owned slot we must actually clear it; a failed clear can't honestly be reported handled
// (would retrap forever), so pre-bail return true (retry), post-bail return false (explicit
// unhandled-breakpoint failure).
function consumeOwnedOrResidual(tid, pc){
  if (ownsAt(tid, 0, pc)) return clearBp(tid, 0) ? true : !bailed;
  if (ownsAt(tid, 1, pc)) return clearBp(tid, 1) ? true : !bailed;
  return residualConsume(tid, pc);
}
function quiescentHandler(d){
  if (d.type !== 'breakpoint') return false;
  return consumeOwnedOrResidual(Process.getCurrentThreadId(), d.context.pc);
}
function bail(){
  if (bailed) return; bailed = true;
  clearWatchdog();
  if (armInterval){ clearInterval(armInterval); armInterval = null; }
  console.log('[!] giving up: hardware breakpoints unavailable/unclearable; going quiescent');
  Process.setExceptionHandler(quiescentHandler);
}

function watchdogFire(){
  captureWatchdog = null;
  if (!(pend && !finished)) return;
  var t = pend.tid;
  var o = owned[t];
  var lr = (o && o[1]) ? o[1] : null;     // capture the owned return bp BEFORE clearing it
  // Gate the abandon on the return bp actually clearing. If it can't clear, RETAIN pend (an
  // exit that fires meanwhile is still captured normally) and retry shortly; clearBp's counter
  // bails on runaway failure.
  if (!clearBp(t, 1)){
    if (!bailed && !finished) captureWatchdog = setTimeout(watchdogFire, 500);
    return;
  }
  // Slot 1 cleared. The LR exception may already be latched/in-flight, so snapshot (t, slot 1,
  // lr) into residual — a straggler is then consumed exactly once instead of arriving with no
  // live ownership and no residual match (which would pass through and could kill the process).
  if (lr) residualPush(t, 1, lr);
  console.log('[!] capture watchdog: return not observed within ' + CAPTURE_TIMEOUT +
              'ms on tid ' + t + ' — abandoned, re-arming');
  pend = null;
  if (!finished && !bailed && !armInterval) armInterval = setInterval(arm, 400);
}
function startWatchdog(){
  clearWatchdog();
  captureWatchdog = setTimeout(watchdogFire, CAPTURE_TIMEOUT);
}
function clearWatchdog(){ if (captureWatchdog){ clearTimeout(captureWatchdog); captureWatchdog = null; } }

// Arm slot 0 on every thread we hold no slot on AND that has no pending residual snapshot.
// `residual` is pruned once per tick (bounded while arming; in terminal states a bounded
// one-time snapshot may persist until the next matching exception or unload — never grows).
// Only a TOTAL inability to arm counts toward bail.
function arm(){
  if (pend || finished || bailed) return;
  pruneResidual(Date.now());
  var ts = threads();
  var map = {}, live = {};
  ts.forEach(function(t){ map[t.id] = t; live[t.id] = true; });
  Object.keys(owned).forEach(function(ids){ if (!live[ids]) delete owned[ids]; });   // fallback reap

  var attempted = 0, armedOk = 0;
  ts.forEach(function(t){
    var o = owned[t.id];
    if (o && (o[0] || o[1])) return;
    if (residualPending(t.id)) return;
    attempted++;
    if (setBp(t.id, 0, addr, t)) armedOk++;
  });

  var working = false;
  for (var id in owned){ if (live[id] && (owned[id][0] || owned[id][1])){ working = true; break; } }
  if (armedOk > 0 || working){
    armFails = 0;
  } else if (attempted > 0){
    if (armFails === 0) console.log('[!] cannot set hardware breakpoint (no free slot / unsupported?) — retrying');
    if (++armFails >= MAX_ARM_FAILS){ console.log('[!] hardware breakpoints unavailable after ' + armFails + ' attempts'); bail(); }
  }
}
// Remove every entry bp (slot 0) we own; snapshot each successfully-removed one (except the
// in-handler thread, which can't re-deliver). Stop rearming (one-shot lock).
function disarmAllEntry(exceptTid){
  if (armInterval){ clearInterval(armInterval); armInterval = null; }
  var map = threadMap();
  Object.keys(owned).forEach(function(ids){
    var tid = parseInt(ids, 10), o = owned[tid];
    if (o && o[0]){ var a = o[0]; if (clearBp(tid, 0, map[tid]) && tid !== exceptTid) residualPush(tid, 0, a); }
  });
}
// Final teardown: remove every slot we still own; snapshot successfully-removed background
// slots. Slots that fail to clear stay owned and are handled by the quiescent handler.
function disarmOwned(exceptTid){
  if (armInterval){ clearInterval(armInterval); armInterval = null; }
  var map = threadMap();
  Object.keys(owned).forEach(function(ids){
    var tid = parseInt(ids, 10), o = owned[tid]; if (!o) return;
    [0, 1].forEach(function(slot){
      if (o[slot]){ var a = o[slot]; if (clearBp(tid, slot, map[tid]) && tid !== exceptTid) residualPush(tid, slot, a); }
    });
  });
}

function onException(d){
  if (d.type !== 'breakpoint') return false;
  var c = d.context, pc = c.pc, tid = Process.getCurrentThreadId();

  // 1. REAL EXIT — the captured call returned on its own thread.
  if (pend && !finished && tid === pend.tid && ownsAt(tid, 1, pc)){
    var dout = hx(pend.data, pend.rd);
    if (!ok(dout)){
      // Couldn't read data_out: capture invalid. Gate the discard on the exit bp actually
      // clearing (retry pre-bail / hard-fail post-bail), then retry on a later call.
      console.log('[!] exit read of data_out failed — discarding capture, re-arming');
      if (!clearBp(tid, 1)) return !bailed;
      clearWatchdog(); pend = null;
      if (!bailed && !armInterval) armInterval = setInterval(arm, 400);
      return true;
    }
    // Best-effort clear (capture already in hand); a failure is absorbed by the owned-aware
    // quiescent handler installed below — the single documented ungated transition.
    clearBp(tid, 1);
    clearWatchdog();
    console.log('[EXIT] dout=' + dout);
    console.log('[CAPTURED] key=' + pend.key);
    console.log('[CAPTURED] nonce=' + pend.nonce + ' ctr=' + pend.ctr + ' len=' + pend.len);
    console.log('[CAPTURED] din=' + pend.din);
    console.log('[CAPTURED] dout=' + dout);
    finished = true;
    disarmOwned(tid);
    pend = null;                        // capture logged; don't leave stale pend for reapThread
    Process.setExceptionHandler(quiescentHandler);
    return true;
  }

  // 2. SKIP RETURN — a skipped (len<=0) call returned; re-arm this thread's entry bp only after
  //    the return bp is confirmed cleared (retry pre-bail, hard-fail post-bail).
  if (!finished && ownsAt(tid, 1, pc) && (!pend || tid !== pend.tid)){
    if (!clearBp(tid, 1)) return !bailed;
    if (!pend && !finished && !bailed) setBp(tid, 0, addr);
    return true;
  }

  // 3. ENTRY — we own slot 0 here.
  if (!pend && !finished && ownsAt(tid, 0, pc)){
    var n = c.x5.toInt32();
    if (n <= 0){
      // Empty/garbage call: remove slot 0 on THIS thread and break at its return so slot 0 is
      // restored synchronously on return. Only set the return bp if slot 0 actually cleared.
      if (!clearBp(tid, 0)) return !bailed;
      if (!setReturnBp(tid, c.lr) && !bailed){ if (!armInterval) armInterval = setInterval(arm, 400); }
      if ((skips++ % 32) === 0) console.log('[.] skipped len<=0 call (n=' + n + ')');
      return true;
    }
    // Real call: lock on ONLY after THIS thread's entry bp is confirmed cleared.
    if (!clearBp(tid, 0)) return !bailed;
    disarmAllEntry(tid);
    if (bailed) return true;               // a clear inside disarmAllEntry may have bailed us
    // Validate inputs before committing; a bad read means a bogus pointer -> abandon and keep
    // waiting (slot 0 on this thread is already off -> async re-arm only).
    var rd = Math.min(n, CAP);
    var key = hx(c.x0, 32), nonce = hx(c.x2, 16), din = hx(c.x4, rd);
    if (!ok(key) || !ok(nonce) || !ok(din)){
      console.log('[!] entry read failed (key/nonce/din) — abandoning this call, staying armed');
      if (!armInterval) armInterval = setInterval(arm, 400);
      return true;
    }
    pend = { tid: tid, key: key, nonce: nonce, ctr: c.x3.toInt32(),
             data: c.x4, len: n, rd: rd, din: din, lr: c.lr };
    console.log('[ENTRY] key=' + pend.key + ' nonce=' + pend.nonce +
                ' ctr=' + pend.ctr + ' len=' + pend.len);
    console.log('[ENTRY] din=' + pend.din);
    if (setReturnBp(tid, c.lr)){          // exit bp on this thread only
      startWatchdog();                     // release pend if this call never returns
    } else {
      // slot 0 already off on this thread -> it advances past addr without retrapping. Do NOT
      // arm() synchronously (would reinstall slot 0 at the current PC -> loop); async re-arm.
      console.log('[!] lr bp fail — dropping this call, staying armed (async)');
      pend = null;
      if (!bailed && !armInterval) armInterval = setInterval(arm, 400);
    }
    return true;
  }

  // 4. Any hit on a slot WE still own but no live branch handled, or a latched removed bp:
  //    consume once. Non-matches (incl. a foreign debugger's) pass through untouched.
  return consumeOwnedOrResidual(tid, pc);
}

function setup(base){
  addr = base.add(OFF_CIPHER);
  console.log('[+] cipher @ ' + addr + ' base=' + base);
  Process.setExceptionHandler(onException);
  // Reap ownership synchronously on thread death (primary defence against TID reuse); arm()
  // also reconciles lazily if this API is unavailable.
  try {
    Process.attachThreadObserver({ onRemoved: function(t){ reapThread(t.id); } });
  } catch (e) {
    console.log('[.] attachThreadObserver unavailable (' + e + ') — using lazy reap in arm()');
  }
  arm();
  armInterval = setInterval(arm, 400);       // pick up threads spawned before entry
}

var iv = setInterval(function(){
  var m = Process.findModuleByName('libgame.so');
  if (m){ clearInterval(iv); setup(m.base); }
}, 30);
