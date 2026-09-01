import { Component, type ErrorInfo, type ReactNode } from "react";

// A crash in a React subtree unmounts the WHOLE app unless something catches
// it - which is why an exception anywhere left nothing but a white window, with
// no clue as to what had failed. This turns that into a message you can read
// and report, and keeps the rest of the page alive.
//
// A class, because catching a render error is the one thing hooks cannot do.
interface Props {
  // What failed, in the user's terms: "the canvas", "the photo editor".
  what: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack somewhere reachable: the message on screen is for the
    // user, the console entry is what a bug report is built from.
    console.error(`${this.props.what} crashed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-panel">
        <h3>{this.props.what} ran into a problem</h3>
        <p>
          Nothing has been lost - the rest of the app is still running, and anything already saved
          is on disk.
        </p>
        <pre className="crash-detail">{error.message || String(error)}</pre>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
