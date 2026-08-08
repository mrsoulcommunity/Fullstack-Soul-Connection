import React from 'react';
import Icon from './Icon.jsx';
import { Section, Toggle } from './settingsPrimitives.jsx';

// Server-selection and failover controls, plus the live readout that makes the
// automatic behaviour legible: what the app currently thinks of this
// connection, which alternatives it has already measured, and why it last
// moved. Everything shown here is computed in the main process -- this file
// only formats it.

const FAILOVER_MODES = [
  {
    key: 'conservative',
    title: 'محافظه‌کار',
    hint: 'فقط وقتی افت کیفیت کاملاً واضح و ادامه‌دار باشد جابه‌جا می‌شود',
  },
  {
    key: 'balanced',
    title: 'متعادل',
    hint: 'تعادل بین واکنش سریع و جلوگیری از جابه‌جایی بی‌مورد (پیشنهادی)',
  },
  {
    key: 'fast',
    title: 'سریع',
    hint: 'با اولین نشانه‌های افت کیفیت واکنش نشان می‌دهد',
  },
];

const tone = (score) => (score == null ? 'na' : score >= 70 ? 'good' : score >= 45 ? 'mid' : 'bad');
const num = (v, unit) => (v == null ? '—' : `${v}${unit || ''}`);

export function HealthReadout({ health }) {
  const active = health?.active;
  const score = active?.score ?? null;
  if (!active || !active.total) {
    return <span className="setting-hint">هنوز اندازه‌گیری نشده — پس از اتصال، کیفیت هر چند ثانیه بررسی می‌شود.</span>;
  }
  return (
    <div className="health-readout">
      <span className={`health-score ${tone(score)}`}>{score == null ? '—' : score}</span>
      <span className="health-metrics mono">
        پینگ {num(active.latency, 'ms')} · جیتر {num(active.jitter, 'ms')} · لاس {num(active.loss, '٪')}
      </span>
    </div>
  );
}

// The card that appears after an automatic switch: previous server, reason,
// new server, outcome. Mirrors the sequence the user would otherwise have to
// reconstruct from a notification they may have missed.
export function FailoverStatus({ event, onDismiss }) {
  if (!event) return null;
  const failed = event.phase === 'failed' || event.ok === false;
  const switching = event.phase === 'switching';

  return (
    <div className={`failover-card ${failed ? 'failed' : switching ? 'busy' : ''}`} role="status">
      <div className="failover-card-head">
        <Icon name={failed ? 'info' : switching ? 'refresh' : 'check'} size={14} />
        <span>{switching ? 'در حال تعویض سرور…' : failed ? 'تعویض سرور ناموفق بود' : 'کیفیت اتصال افت کرد'}</span>
        {!switching && (
          <button className="icon-btn ghost failover-card-close" onClick={onDismiss} title="بستن">
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      <div className="failover-card-body">
        {event.from && (
          <div className="failover-line">
            <span className="failover-key">سرور قبلی</span>
            <span className="failover-val">{event.from.name}</span>
          </div>
        )}
        {event.reasonText && (
          <div className="failover-line">
            <span className="failover-key">دلیل</span>
            <span className="failover-val reason">{event.reasonText}</span>
          </div>
        )}
        {event.to && (
          <div className="failover-line">
            <span className="failover-key">سرور جدید</span>
            <span className="failover-val">{event.to.name}</span>
          </div>
        )}
        <div className="failover-line">
          <span className="failover-key">وضعیت</span>
          <span className={`failover-val ${failed ? 'bad' : switching ? '' : 'good'}`}>
            {switching ? 'در حال برقراری اتصال…' : failed ? (event.message || 'اتصال برقرار نشد') : '✓ اتصال بازیابی شد'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function FailoverSettings({ settings, health, failover, onUpdate }) {
  const backup = (health?.backup || []).filter((b) => b.score != null).slice(0, 4);
  const last = failover?.lastEvent;

  return (
    <>
      <Section title="انتخاب هوشمند سرور" icon="radar" description="امتیاز کلی سرور، نه فقط پینگ">
        <Toggle
          label="انتخاب خودکار بهترین سرور"
          hint="هنگام اتصال، سرورها بر اساس پینگ، جیتر، پکت‌لاس و پایداری امتیازدهی و بهترین انتخاب می‌شود"
          checked={!!settings.autoSelectBestServer}
          onChange={(v) => onUpdate({ autoSelectBestServer: v })}
        />
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">کیفیت اتصال فعلی</span>
            <HealthReadout health={health} />
          </div>
        </div>
      </Section>

      <Section title="جابه‌جایی خودکار سرور" icon="shield" description="بازیابی خودکار وقتی سرور فعلی خراب می‌شود">
        <Toggle
          label="جابه‌جایی خودکار هنگام افت کیفیت"
          hint="اگر پینگ، پکت‌لاس یا جیتر در چند بررسی پیاپی بد بماند، به سرور بهتری منتقل می‌شوی"
          checked={!!settings.failoverEnabled}
          onChange={(v) => onUpdate({ failoverEnabled: v })}
        />

        {settings.failoverEnabled && (
          <>
            <div className="setting-row column">
              <div className="setting-text">
                <span className="setting-label">حساسیت</span>
                <span className="setting-hint">
                  تعیین می‌کند چند بررسی پیاپی بد لازم است و سرور جایگزین چقدر باید بهتر باشد
                </span>
              </div>
              <div className="routing-modes compact">
                {FAILOVER_MODES.map((m) => (
                  <button
                    key={m.key}
                    className={`routing-mode ${settings.failoverMode === m.key ? 'on' : ''}`}
                    onClick={() => onUpdate({ failoverMode: m.key })}
                    title={m.title}
                    aria-pressed={settings.failoverMode === m.key}
                  >
                    <span className="routing-mode-title">{m.title}</span>
                    <span className="routing-mode-hint">{m.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <Toggle
              label="پایش سرورهای پشتیبان"
              hint="سلامت سرورهای جایگزین در پس‌زمینه سنجیده می‌شود تا لحظه‌ی خرابی، بهترین گزینه از قبل معلوم باشد"
              checked={!!settings.backupMonitoring}
              onChange={(v) => onUpdate({ backupMonitoring: v })}
            />

            {backup.length > 0 && (
              <div className="setting-row column">
                <div className="setting-text">
                  <span className="setting-label">بهترین جایگزین‌های سنجیده‌شده</span>
                </div>
                <div className="backup-list">
                  {backup.map((b) => (
                    <div className="backup-item" key={b.id}>
                      <span className={`health-score small ${tone(b.score)}`}>{b.score}</span>
                      <span className="backup-name">{b.name}</span>
                      <span className="backup-meta mono">
                        {num(b.latency, 'ms')}
                        {b.measured === 'tunnel' ? ' · تونل واقعی' : ' · پینگ شبکه'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {last && (
              <div className="setting-row">
                <div className="setting-text">
                  <span className="setting-label">آخرین جابه‌جایی خودکار</span>
                  <span className="setting-hint">
                    {last.ok ? '✓ ' : '✕ '}
                    {last.from?.name ? `از «${last.from.name}» ` : ''}
                    {last.to?.name ? `به «${last.to.name}» ` : ''}
                    {last.reasonText ? `— ${last.reasonText}` : ''}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </Section>
    </>
  );
}
