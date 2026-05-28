import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

document.getElementById("boot-fallback")?.remove();

type ErrorBoundaryProps = React.PropsWithChildren;
type ErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <RuntimeErrorPage error={this.state.error} />;
    }

    return this.props.children;
  }
}

function Root() {
  const [fatalError, setFatalError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const onError = (event: ErrorEvent) => {
      setFatalError(event.error instanceof Error ? event.error : new Error(event.message || "页面运行失败"));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      setFatalError(reason instanceof Error ? reason : new Error(String(reason ?? "Promise rejected")));
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  if (fatalError) {
    return <RuntimeErrorPage error={fatalError} />;
  }

  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

function RuntimeErrorPage(props: { error: Error }) {
  return (
    <main className="route-error runtime-error">
      <div>
        <h1>页面运行失败</h1>
        <p>{props.error.message || "前端脚本执行时出现异常。"}</p>
        <pre>{props.error.stack ?? props.error.message}</pre>
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
