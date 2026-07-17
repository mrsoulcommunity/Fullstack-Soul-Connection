import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Icon from './Icon.jsx';

function slugify(text) {
  return (text || 'qrcode')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'qrcode';
}

// High-resolution target: qrcode picks the largest integer per-module scale
// that fits inside this many pixels, so the PNG stays crisp (no interpolation
// blur) at any save/share size instead of being a soft, upscaled bitmap.
const QR_PIXEL_TARGET = 640;

export default function QrModal({ title, subtitle, value, onClose, onToast }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError('');
    QRCode.toDataURL(value || '', {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: QR_PIXEL_TARGET,
      color: { dark: '#0a0d13ff', light: '#ffffffff' },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setError('این لینک برای تبدیل به QR خیلی بزرگ است.'); });
    return () => { cancelled = true; };
  }, [value, attempt]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  async function handleCopyImage() {
    if (!dataUrl) return;
    setBusy(true);
    try {
      await window.soul.copyImage(dataUrl);
      onToast?.('تصویر QR کپی شد');
    } catch {
      onToast?.('کپی تصویر ناموفق بود', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveImage() {
    if (!dataUrl) return;
    setBusy(true);
    try {
      const res = await window.soul.saveImage(dataUrl, `${slugify(title)}-qrcode.png`);
      if (!res.canceled) onToast?.('تصویر QR ذخیره شد');
    } catch {
      onToast?.('ذخیره‌ی تصویر ناموفق بود', 'error');
    } finally {
      setBusy(false);
    }
  }

  function handleCopyLink() {
    navigator.clipboard?.writeText(value || '')
      .then(() => onToast?.('لینک کپی شد'))
      .catch(() => onToast?.('کپی ناموفق بود', 'error'));
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal qr-modal">
        <h3>اشتراک‌گذاری با QR</h3>
        {subtitle && <p className="hint">{subtitle}</p>}

        <div className="qr-stage">
          {error ? (
            <div className="qr-state qr-error">
              <div className="qr-error-icon">
                <Icon name="info" size={20} />
              </div>
              <span className="qr-state-msg">{error}</span>
              <button className="btn mini qr-retry" onClick={handleRetry}>
                <Icon name="refresh" size={12} /> تلاش دوباره
              </button>
            </div>
          ) : dataUrl ? (
            <div className="qr-card">
              <img className="qr-img" src={dataUrl} alt="QR Code" draggable={false} />
            </div>
          ) : (
            <div className="qr-state qr-loading" aria-live="polite">
              <span className="qr-spinner" aria-hidden="true" />
              <span className="qr-state-msg">در حال تولید QR…</span>
            </div>
          )}
        </div>

        <div className="sub-url-row">
          <span className="sub-url mono">{value}</span>
          <button className="icon-btn" onClick={handleCopyLink} title="کپی لینک">
            <Icon name="copy" size={13} />
          </button>
        </div>

        <div className="qr-actions">
          <button className="btn" disabled={!dataUrl || busy} onClick={handleCopyImage}>
            <Icon name="copy" size={13} /> کپی تصویر
          </button>
          <button className="btn" disabled={!dataUrl || busy} onClick={handleSaveImage}>
            <Icon name="download" size={13} /> ذخیره تصویر
          </button>
        </div>

        <div className="row">
          <button className="btn primary" onClick={onClose}>بستن</button>
        </div>
      </div>
    </div>
  );
}
