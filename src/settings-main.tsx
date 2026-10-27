import React from "react";
import { createRoot } from "react-dom/client";
import SettingsPage from "./SettingsPage";
import "./styles.css";
import "./settings.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
);
