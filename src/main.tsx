import { Statistics } from "./Statistics";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { Archive } from "./Archive";
import { Admin } from "./Admin";
import { Dashboard, EventEditor } from "./Dashboard";
const GuestEntry=lazy(()=>import("./GuestEntry").then(m=>({default:m.GuestEntry})));
const SpeakerRoom = lazy(() =>
  import("./SpeakerRoom").then((m) => ({ default: m.SpeakerRoom })),
);
const Studio = lazy(() =>
  import("./Studio").then((m) => ({ default: m.Studio })),
);
const Assistance = lazy(() =>
  import("./Assistance").then((m) => ({ default: m.Assistance })),
);
const Viewer = lazy(() =>
  import("./Viewer").then((m) => ({ default: m.Viewer })),
);
import "./styles.css";
import "./theme.css";
import "./arslive.css";
const [route, id] = location.pathname.split("/").filter(Boolean);
createRoot(document.getElementById("root")!).render(
  <Suspense
    fallback={
      <main className="page">
        <p>Открываем кабинет…</p>
      </main>
    }
  >
    {route === "guest" && id ? <GuestEntry id={id}/> : route === "speaker" && id ? (
      <SpeakerRoom id={id} />
    ) : route === "statistics" ? (
      <Statistics />
    ) : route === "admin" ? (
      <Admin />
    ) : route === "archive" && id ? (
      <Archive id={id} />
    ) : route === "assist" && id ? (
      <Assistance id={id} />
    ) : route === "studio" && id ? (
      <Studio id={id} />
    ) : route === "event" && id ? (
      <EventEditor id={id} />
    ) : route === "room" && id ? (
      <Viewer slug={id} />
    ) : (
      <Dashboard />
    )}
  </Suspense>,
);
