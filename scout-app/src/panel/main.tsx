import React from "react";
import ReactDOM from "react-dom/client";
import PanelApp from "./PanelApp";
import "../index.css";
import { initializeTheme } from "../lib/theme";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PanelApp />
  </React.StrictMode>,
);
