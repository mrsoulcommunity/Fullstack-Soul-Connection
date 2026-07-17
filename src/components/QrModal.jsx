import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Icon from './Icon.jsx';

function slugify(text) {
  return (text || 'qrcode')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'qrcode';
}

export default function QrModal({ title, subtitle, value, onClose, onToast }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError('');
    QRCode.toDataURL(value || '', {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 7,
      color: { dark: '#0a0d13', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setError('این لینک برای تبدیل به QR خیلی بزرگ است.'); });
    return () => { cancelled = true; };
  }, [value]);

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
            <div className="qr-error">
              <Icon name="info" size={20} />
              <span>{error}</span>
            </div>
          ) : dataUrl ? (
            <img className="qr-img" src={dataUrl} alt="QR Code" draggable={false} />
          ) : (
            <div className="qr-skeleton" aria-hidden="true" />
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
