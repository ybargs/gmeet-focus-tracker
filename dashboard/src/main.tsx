import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./dashboard-theme.css";
import "./redesign.css";
import "./modern.css";
import "./refine.css";
import "./stats.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
