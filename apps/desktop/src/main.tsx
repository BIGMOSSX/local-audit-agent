import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { tauriDropSource } from "./dragdrop";
import {
  createAuditClient,
  createModelClient,
  createProjectClient,
  tauriPickFolder,
  tauriTransport,
} from "./ipc";
import "./styles.css";

const client = createProjectClient(tauriTransport);
const models = createModelClient(tauriTransport);
const audit = createAuditClient(tauriTransport);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App
      client={client}
      models={models}
      audit={audit}
      pickFolder={tauriPickFolder}
      dropSource={tauriDropSource}
    />
  </StrictMode>,
);
