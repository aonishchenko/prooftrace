import { TickMark } from "./icons";

/** Top bar with the ProofTrace wordmark (studio design). */
export function Header() {
  return (
    <header className="bar">
      <a className="wm" href="/" aria-label="ProofTrace home">
        <span>Proof</span>
        <span className="wm__trace">Trace</span>
        <TickMark />
      </a>
      <nav className="nav" aria-label="Main">
        <a href="https://github.com/aonishchenko/prooftrace/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noreferrer">
          How it works
        </a>
      </nav>
    </header>
  );
}
