import React, { useRef, useState } from 'react';
import Loader from '../common/Loader';
import ErrorMessage from '../common/ErrorMessage';
import './DashboardComponents.css';

// ── File type config ───────────────────────────────────────────────────────────
const TYPE_CONFIG = {
  // Spreadsheets
  'text/csv'                    : { label: 'CSV',  category: 'data'  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'XLSX', category: 'data' },
  'application/vnd.ms-excel'    : { label: 'XLS',  category: 'data'  },
  // XML
  'application/xml'             : { label: 'XML',  category: 'data'  },
  'text/xml'                    : { label: 'XML',  category: 'data'  },
  // ZIP
  'application/zip'             : { label: 'ZIP',  category: 'data'  },
  'application/x-zip-compressed': { label: 'ZIP',  category: 'data'  },
  // PDF & Images (OCR)
  'application/pdf'             : { label: 'PDF',  category: 'ocr'   },
  'image/png'                   : { label: 'PNG',  category: 'ocr'   },
  'image/jpeg'                  : { label: 'JPG',  category: 'ocr'   },
  'image/tiff'                  : { label: 'TIFF', category: 'ocr'   },
  'image/bmp'                   : { label: 'BMP',  category: 'ocr'   },
  'image/webp'                  : { label: 'WEBP', category: 'ocr'   },
  // Fallback for browsers that send octet-stream
  'application/octet-stream'    : { label: 'FILE', category: 'data'  },
};

// Extension → MIME fallback (for browsers that don't set MIME correctly)
const EXT_ALLOWED = /\.(csv|xlsx|xls|xml|zip|pdf|png|jpg|jpeg|tiff|tif|bmp|webp)$/i;
const EXT_OCR     = /\.(pdf|png|jpg|jpeg|tiff|tif|bmp|webp)$/i;

const MAX_SIZE_MB      = 500;   // ← raised from 50 MB to 500 MB
const MAX_SIZE_BYTES   = MAX_SIZE_MB * 1024 * 1024;

export default function UploadZone({
  onUpload,
  loading       = false,
  error         = '',
  title         = 'Drop your file here',
  subtitle      = `or click to browse · max ${MAX_SIZE_MB} MB`,
  sampleLabel   = 'Use sample file →',
  sampleFile    = '__sample__',
  acceptedFormats = '.csv,.xlsx,.xls,.xml,.zip,.pdf,.png,.jpg,.jpeg,.tiff,.tif',
  showOcrBadge  = true,   // show "🔍 OCR supported" hint for PDF/image
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver]   = useState(false);
  const [fileError, setFileError] = useState('');

  function handleFile(file) {
    if (!file) return;
    setFileError('');

    // Size check
    if (file.size > MAX_SIZE_BYTES) {
      setFileError(`File too large. Maximum size is ${MAX_SIZE_MB} MB.`);
      return;
    }

    // Type check — use MIME first, fall back to extension
    const mimeAllowed = file.type in TYPE_CONFIG;
    const extAllowed  = EXT_ALLOWED.test(file.name);

    if (!mimeAllowed && !extAllowed) {
      setFileError(
        `Unsupported file type: "${file.name}". ` +
        `Accepted: CSV, XLSX, XLS, XML, ZIP, PDF, PNG, JPG, TIFF`
      );
      return;
    }

    onUpload(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  }

  // Determine display title based on acceptedFormats
  const acceptsOCR  = acceptedFormats.includes('pdf') || acceptedFormats.includes('png');
  const acceptsZip  = acceptedFormats.includes('zip');

  const displayTitle = title !== 'Drop your file here' ? title
    : acceptsOCR
      ? 'Drop your invoice file here'
      : 'Drop your CSV or Excel file here';

  const displaySub = subtitle !== `or click to browse · max ${MAX_SIZE_MB} MB`
    ? subtitle
    : `or click to browse · max ${MAX_SIZE_MB} MB`;

  const combinedError = error || fileError;

  return (
    <div className="upload-zone-wrap">

      <div
        className={`upload-zone ${dragOver ? 'upload-zone--dragover' : ''} ${loading ? 'upload-zone--loading' : ''}`}
        onClick={() => !loading && inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        aria-label="File upload zone"
        onKeyDown={e => e.key === 'Enter' && !loading && inputRef.current.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={acceptedFormats}
          style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files[0])}
        />

        {loading ? (
          <Loader message="Uploading and parsing file…" />
        ) : (
          <>
            <div className="upload-zone__icon">⬆</div>
            <div className="upload-zone__title">{displayTitle}</div>
            <div className="upload-zone__sub">{displaySub}</div>

            {/* Accepted format badges */}
            <div className="upload-zone__formats">
              {acceptedFormats
                .split(',')
                .map(f => f.trim().replace('.', '').toUpperCase())
                .filter(Boolean)
                .map(fmt => (
                  <span
                    key={fmt}
                    className={`upload-zone__fmt-badge ${
                      EXT_OCR.test(`.${fmt.toLowerCase()}`)
                        ? 'upload-zone__fmt-badge--ocr'
                        : ''
                    }`}
                  >
                    {EXT_OCR.test(`.${fmt.toLowerCase()}`) ? `🔍 ${fmt}` : fmt}
                  </span>
                ))}
            </div>

            {/* OCR hint */}
            {showOcrBadge && acceptsOCR && (
              <div className="upload-zone__ocr-hint">
                PDF and image invoices are processed with OCR automatically
              </div>
            )}
          </>
        )}
      </div>

      {combinedError && (
        <ErrorMessage message={combinedError} onRetry={() => setFileError('')} />
      )}

      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <button
          className="btn-ghost"
          style={{ fontSize: 13 }}
          onClick={() => onUpload(sampleFile)}
          disabled={loading}
        >
          {sampleLabel}
        </button>
      </div>
    </div>
  );
}
