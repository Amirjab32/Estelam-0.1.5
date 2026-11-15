import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Camera, Flashlight, RefreshCw, AlertCircle } from 'lucide-react';
import { normalizeBarcodeInput } from '../utils/barcodeUtils.ts';

interface CameraBarcodeViewportProps {
  active: boolean;
  onDetected: (normalizedCode: string) => void;
  compact?: boolean;
}

const TARGET_BARCODE_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];

const NATIVE_DETECTOR_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
  'data_matrix',
];

export const CameraBarcodeViewport: React.FC<CameraBarcodeViewportProps> = ({
  active,
  onDetected,
  compact = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDetectedRef = useRef(onDetected);
  const lastDetectionRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [status, setStatus] = useState<'initializing' | 'ready' | 'error'>('initializing');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [engineLabel, setEngineLabel] = useState<string>('موتور اسکن نوری');
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let activeStream: MediaStream | null = null;
    let pollTimer: number | null = null;
    let zxingControls: { stop: () => void } | null = null;

    const emitDetection = (rawText: string) => {
      const normalized = normalizeBarcodeInput(rawText);
      if (!normalized) return;

      const now = Date.now();
      if (
        lastDetectionRef.current.code === normalized &&
        now - lastDetectionRef.current.at < 1600
      ) {
        return;
      }

      lastDetectionRef.current = { code: normalized, at: now };
      onDetectedRef.current(normalized);
    };

    const startCamera = async () => {
      setStatus('initializing');
      setErrorMessage('');
      setTorchOn(false);
      setTorchSupported(false);

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        setStatus('error');
        setErrorMessage(
          'دسترسی به دوربین در این آدرس در دسترس نیست. لطفاً سایت را با HTTPS یا localhost باز کنید.'
        );
        return;
      }

      try {
        const videoConstraints: MediaTrackConstraints = selectedDeviceId
          ? {
              deviceId: { exact: selectedDeviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            };

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        activeStream = stream;
        const primaryTrack = stream.getVideoTracks()[0] || null;
        trackRef.current = primaryTrack;

        if (primaryTrack && typeof primaryTrack.getCapabilities === 'function') {
          const caps = primaryTrack.getCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
          };
          setTorchSupported(Boolean(caps?.torch));
        }

        if (navigator.mediaDevices.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
          if (!cancelled) {
            const videoInputs = devices.filter((d) => d.kind === 'videoinput');
            setCameras(videoInputs);
          }
        }

        const videoEl = videoRef.current;
        if (!videoEl) return;

        videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});

        if (cancelled) return;
        setStatus('ready');

        const NativeBarcodeDetector = (window as unknown as {
          BarcodeDetector?: {
            new (opts?: { formats?: string[] }): {
              detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
            };
            getSupportedFormats?: () => Promise<string[]>;
          };
        }).BarcodeDetector;

        if (NativeBarcodeDetector) {
          try {
            let formatsToUse = NATIVE_DETECTOR_FORMATS;
            if (typeof NativeBarcodeDetector.getSupportedFormats === 'function') {
              const supported = await NativeBarcodeDetector.getSupportedFormats();
              const intersected = NATIVE_DETECTOR_FORMATS.filter((f) => supported.includes(f));
              if (intersected.length > 0) {
                formatsToUse = intersected;
              }
            }
            const detector = new NativeBarcodeDetector({ formats: formatsToUse });
            setEngineLabel('اسکنر سخت‌افزاری مرورگر');

            let detecting = false;
            pollTimer = window.setInterval(async () => {
              if (cancelled || detecting || !videoRef.current || videoRef.current.readyState < 2) {
                return;
              }
              detecting = true;
              try {
                const barcodes = await detector.detect(videoRef.current);
                if (barcodes && barcodes.length > 0 && barcodes[0]?.rawValue) {
                  emitDetection(barcodes[0].rawValue);
                }
              } catch {
                // Ignore transient frame decode failures
              } finally {
                detecting = false;
              }
            }, 130);
            return;
          } catch {
            // Fall through cleanly to ZXing engine
          }
        }

        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, TARGET_BARCODE_FORMATS);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: 600,
        });
        setEngineLabel('موتور اسکن نوری چندفرمت');

        zxingControls = await reader.decodeFromStream(stream, videoEl, (result) => {
          if (cancelled || !result) return;
          const text = result.getText();
          if (text) {
            emitDetection(text);
          }
        });
      } catch (err: unknown) {
        if (cancelled) return;
        const name = (err as { name?: string })?.name || '';
        setStatus('error');
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setErrorMessage(
            'اجازه دسترسی به دوربین داده نشد. لطفاً دسترسی دوربین را در مرورگر فعال کنید یا از ورود دستی/بارکدخوان استفاده نمایید.'
          );
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setErrorMessage('دوربینی روی این دستگاه شناسایی نشد.');
        } else {
          setErrorMessage(
            'امکان راه‌اندازی دوربین فراهم نشد. مطمئن شوید دوربین در برنامه دیگری باز نیست.'
          );
        }
      }
    };

    startCamera();

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      if (zxingControls) {
        try {
          zxingControls.stop();
        } catch {
          // Ignore stop errors
        }
      }
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
      }
      trackRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [active, selectedDeviceId, retryNonce]);

  const handleToggleTorch = async () => {
    const track = trackRef.current;
    if (!track || !torchSupported) return;
    const nextState = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextState } as MediaTrackConstraintSet],
      });
      setTorchOn(nextState);
    } catch {
      // Torch constraint rejected on this hardware
    }
  };

  const handleCycleCamera = () => {
    if (cameras.length < 2) return;
    const currentIdx = cameras.findIndex((c) => c.deviceId === selectedDeviceId);
    const nextCamera = cameras[(currentIdx + 1) % cameras.length];
    if (nextCamera?.deviceId) {
      setSelectedDeviceId(nextCamera.deviceId);
    }
  };

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950 ${
        compact ? 'h-48 sm:h-56' : 'h-60 sm:h-72'
      }`}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="w-full h-full object-cover"
      />

      {/* Top Overlay Controls */}
      <div className="absolute top-2.5 inset-x-2.5 flex items-center justify-between gap-2 z-10">
        <span className="px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-700/80 text-[11px] text-slate-200 font-medium">
          {status === 'ready' ? engineLabel : 'در حال اتصال به دوربین...'}
        </span>

        <div className="flex items-center gap-1.5">
          {torchSupported && (
            <button
              type="button"
              onClick={handleToggleTorch}
              title={torchOn ? 'خاموش کردن چراغ‌قوه' : 'روشن کردن چراغ‌قوه'}
              className={`min-h-[34px] px-2.5 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1 transition ${
                torchOn
                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                  : 'bg-slate-950/80 text-slate-200 border-slate-700 hover:bg-slate-900'
              }`}
            >
              <Flashlight className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">فلش</span>
            </button>
          )}

          {cameras.length > 1 && (
            <button
              type="button"
              onClick={handleCycleCamera}
              title="تغییر دوربین"
              className="min-h-[34px] px-2.5 py-1.5 rounded-lg bg-slate-950/80 hover:bg-slate-900 text-slate-200 border border-slate-700 text-xs font-medium inline-flex items-center gap-1 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">تغییر دوربین</span>
            </button>
          )}
        </div>
      </div>

      {/* Crisp Viewfinder Reticle when Camera is Ready */}
      {status === 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative w-64 max-w-[78%] h-32 rounded-xl border border-indigo-400/40 bg-slate-950/10">
            <span className="absolute -top-0.5 -right-0.5 w-5 h-5 border-t-2 border-r-2 border-emerald-400 rounded-tr-lg" />
            <span className="absolute -top-0.5 -left-0.5 w-5 h-5 border-t-2 border-l-2 border-emerald-400 rounded-tl-lg" />
            <span className="absolute -bottom-0.5 -right-0.5 w-5 h-5 border-b-2 border-r-2 border-emerald-400 rounded-br-lg" />
            <span className="absolute -bottom-0.5 -left-0.5 w-5 h-5 border-b-2 border-l-2 border-emerald-400 rounded-bl-lg" />
            <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 h-[1.5px] bg-emerald-400/75" />
          </div>
        </div>
      )}

      {/* Initializing Overlay */}
      {status === 'initializing' && (
        <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center gap-2 text-slate-300 text-xs">
          <Camera className="w-7 h-7 text-indigo-400 animate-pulse" />
          <span>در حال فعال‌سازی دوربین دستگاه...</span>
        </div>
      )}

      {/* Error Overlay */}
      {status === 'error' && (
        <div className="absolute inset-0 bg-slate-950/95 p-4 flex flex-col items-center justify-center text-center gap-3">
          <AlertCircle className="w-7 h-7 text-rose-400" />
          <p className="text-xs text-rose-200 max-w-sm leading-relaxed">{errorMessage}</p>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="min-h-[36px] px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold inline-flex items-center gap-1.5 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>درخواست مجدد اجازه دوربین</span>
          </button>
        </div>
      )}
    </div>
  );
};
