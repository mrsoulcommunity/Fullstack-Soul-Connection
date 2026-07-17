import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as engine from '../finder/testEngine.js';
import { recommend } from '../utils/score.js';
import TestDashboard from './TestDashboard.jsx';

const PRIORITY = 'balanced';

// Runs a live test batch (via the shared Server Finder engine) scoped to a
// single subscription's profiles, reusing TestDashboard for the same
// professional live UI as the finder. When `autoConnectBest` is set, the
// best-scoring server is connected to automatically once the batch finishes.
export default function SubTestModal({
  sub, profiles, mode = 'ping', autoConnectBest = false,
  activeProfileId, connectionState, onConnect, onClose, onToast,
}) {
  const t = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const subProfiles = useMemo(() => profiles.filter((p) => p.subId === sub.id), [profiles, sub.id]);
  const startedRef = useRef(false);
  const autoConnectedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    engine.setProfileNames(Object.fromEntries(profiles.map((p) => [p.id, p.name || p.address])));
    if (engine.getSnapshot().status === 'idle' && subProfiles.length) {
      engine.startBatch(subProfiles.map((p) => p.id), mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoConnectBest || autoConnectedRef.current) return;
    if (t.status !== 'idle' || !t.lastBatch) return;
    autoConnectedRef.current = true;
    const best = recommend(subProfiles, t.results, PRIORITY);
    if (best) {
      onConnect(best.profile.id);
      onToast?.(`به بهترین سرور «${best.profile.name || best.profile.address}» وصل شد — امتیاز ${best.score}`);
    } else {
      onToast?.('هیچ سروری از این ساب‌اسکریپشن در دسترس نبود', 'error');
    }
  }, [t.status, t.lastBatch, autoConnectBest, subProfiles, t.results, onConnect, onToast]);

  return (
    <div className="finder-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder dash-mode" role="dialog" aria-label={`تست سرورهای ${sub.name}`}>
        <TestDashboard
          t={t}
          profiles={subProfiles}
          priority={PRIORITY}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onBack={onClose}
          onConnect={onConnect}
          onRetest={() => {
            if (t.batchIds.length && t.status === 'idle') {
              engine.startBatch(t.batchIds, t.lastBatch?.mode || mode);
            }
          }}
        />
      </div>
    </div>
  );
}
