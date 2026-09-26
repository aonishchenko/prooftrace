import { useEffect, useRef, useState } from "react";

/** Shows a draft evidenceRequest with a Copy button. Never sends anything. */
export function EvidenceRequestModal({ text, onClose }: { text: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="evidence-modal" aria-labelledby="evidence-modal-title">
      <h3 id="evidence-modal-title" className="serif">Request missing evidence</h3>
      <p className="evidence-modal__hint">Draft only. ProofTrace never sends this.</p>
      <textarea readOnly value={text} rows={8} aria-label="Draft evidence request" />
      <div className="evidence-modal__actions">
        <button type="button" className="cta" onClick={handleCopy}>
          {copied ? "Copied" : "Copy evidence request"}
        </button>
        <button type="button" className="textlink" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
