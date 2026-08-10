import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocumentApp } from "./DocumentApp.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocumentApp />
  </StrictMode>
);
