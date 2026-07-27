import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeTheme } from "./lib/theme";

initializeTheme();

const showcaseEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has("showcase");
const Showcase = showcaseEnabled ? React.lazy(() => import("./Showcase")) : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {Showcase ? <Suspense fallback={null}><Showcase /></Suspense> : <App />}
  </React.StrictMode>,
);
