const $ = id => document.getElementById(id);
const DB_NAME = "SiteGuardOffline";
let db;

function openLocalDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", {
      keyPath: "localId", autoIncrement: true
    });
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function queueReport(data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add(data);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getQueue() {
  return new Promise((resolve, reject) => {
    const req = db.transaction("queue").objectStore("queue").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteQueued(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function sendReport(report) {
  const form = new FormData();
  form.append("worker_id", report.worker_id);
  form.append("location", report.location);
  form.append("incident", report.incident);
  if (report.photo) form.append("photo", report.photo);

  const response = await fetch("/api/emergency", {
    method: "POST", body: form
  });
  if (!response.ok) throw new Error("Server rejected report");
  return response.json();
}

async function syncQueue() {
  if (!navigator.onLine || !db) return;
  const items = await getQueue();
  for (const item of items) {
    try {
      await sendReport(item);
      await deleteQueued(item.localId);
    } catch (_) {
      break;
    }
  }
  await updatePending();
  await refreshDashboard();
}

async function updatePending() {
  const items = await getQueue();
  $("pending").textContent = items.length;
}

function showNetwork() {
  const online = navigator.onLine;
  $("network").textContent = online ? "Network available" : "Offline mode";
  $("dot").style.background = online ? "#61e5b2" : "#ff5e70";
}

async function refreshDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    if (!res.ok) throw new Error("Backend unavailable");
    const data = await res.json();
    $("workers").textContent = data.workers;
    $("openCount").textContent = data.open_incidents;
    $("risk").innerHTML = `${data.risk_score}<span>/100</span>`;
    $("riskLevel").textContent = `${data.risk_level} RISK`;
    renderIncidents(data.incidents);
  } catch (_) {
    $("sosResult").textContent =
      "Backend unavailable. New SOS reports can be queued on this device.";
  }
}

function renderIncidents(items) {
  const body = $("incidentRows");
  body.replaceChildren();

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="7">No incidents recorded yet.</td></tr>';
    return;
  }

  items.forEach(item => {
    const tr = document.createElement("tr");
    const values = [
      "#" + item.id, item.worker_id, item.location, item.incident,
      new Date(item.created_at).toLocaleString(), item.status
    ];
    values.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      if (index === 5) {
        td.className = "status" + (value === "RESOLVED" ? " resolved" : "");
      }
      tr.appendChild(td);
    });

    const action = document.createElement("td");
    if (item.status !== "RESOLVED") {
      const btn = document.createElement("button");
      btn.className = "resolve";
      btn.textContent = "Resolve";
      btn.onclick = async () => {
        try {
          const res = await fetch(`/api/incidents/${item.id}/resolve`, {
            method: "PATCH"
          });
          if (!res.ok) throw new Error();
          await refreshDashboard();
        } catch (_) {
          alert("Cannot resolve while the server is offline.");
        }
      };
      action.appendChild(btn);
    } else {
      action.textContent = "Completed";
    }
    tr.appendChild(action);
    body.appendChild(tr);
  });
}

$("sosForm").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("photo").files[0];
  const report = {
    worker_id: $("workerId").value.trim(),
    location: $("location").value.trim(),
    incident: $("incident").value,
    photo: file || null
  };

  $("sosResult").textContent = "Saving SOS report...";
  try {
    if (navigator.onLine) {
      await sendReport(report);
      $("sosResult").textContent =
        "SOS report sent to the SiteGuard backend. Emergency services are NOT automatically notified.";
    } else {
      await queueReport(report);
      $("sosResult").textContent =
        "Offline: report saved on this device. It has NOT reached the supervisor yet.";
    }
    $("sosForm").reset();
  } catch (_) {
    try {
      await queueReport(report);
      $("sosResult").textContent =
        "Server unavailable: report queued locally and will retry when online.";
    } catch (error) {
      $("sosResult").textContent =
        "Could not save report. Check browser storage and available space.";
    }
  }
  await updatePending();
  await refreshDashboard();
});

$("zoneButton").addEventListener("click", async () => {
  const zone = $("zone").value;
  if (zone === "Safe Zone") {
    $("zoneResult").textContent = "✓ Simulated worker is in a safe zone.";
    $("zoneResult").style.color = "#61e5b2";
    return;
  }

  $("zoneResult").textContent = `⚠ DANGER: Simulated worker entered ${zone}. Notify the site supervisor.`;
  $("zoneResult").style.color = "#ff6a79";

  try {
    await fetch("/api/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worker_id: $("workerId").value.trim() || "DEMO-001",
        location: zone,
        incident: "Danger-zone entry: " + zone
      })
    });
    await refreshDashboard();
  } catch (_) {
    $("zoneResult").textContent += " Backend offline; this test was not saved.";
  }
});

$("ppeButton").addEventListener("click", () => {
  if (!$("ppeFile").files.length) {
    $("ppeResult").textContent = "Please select a sample image or video first.";
    return;
  }
  $("ppeResult").textContent =
    "Sample selected. Real helmet/vest detection requires connecting a trained PPE AI model. This demo does not claim to detect PPE.";
});

window.addEventListener("online", async () => {
  showNetwork();
  await syncQueue();
});
window.addEventListener("offline", showNetwork);

(async function start() {
  showNetwork();
  try { await openLocalDB(); await updatePending(); } catch (_) {
    $("sosResult").textContent = "Offline storage is unavailable in this browser.";
  }
  await refreshDashboard();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  if (navigator.onLine) await syncQueue();
})();
