import { useState, type FormEvent } from "react";

interface InvestigateFormProps {
  url: string;
  onUrlChange: (url: string) => void;
  onSubmit: (url: string) => void;
  disabled: boolean;
}

export function InvestigateForm({ url, onUrlChange, onSubmit, disabled }: InvestigateFormProps) {
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError("Enter a URL starting with http:// or https://");
      return;
    }
    setError(null);
    onSubmit(trimmed);
  };

  return (
    <div>
      <form className="ask" onSubmit={handleSubmit}>
        <label htmlFor="url-input" className="sr-only">
          Page URL
        </label>
        <input
          id="url-input"
          type="url"
          required
          placeholder="https://www.garnier.pt/"
          value={url}
          onChange={(event) => {
            onUrlChange(event.target.value);
            if (error) setError(null);
          }}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "url-input-error" : undefined}
        />
        <button type="submit" className="cta" disabled={disabled}>
          {disabled ? "Investigating…" : "Investigate"}
        </button>
      </form>
      {error && (
        <p id="url-input-error" className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
