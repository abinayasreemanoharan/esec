from flask import Flask, request, jsonify, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
import sqlite3
import os

app = Flask(__name__)
ROOT = os.path.dirname(os.path.abspath(__file__))
UPLOADS = os.path.join(ROOT, "uploads")
DB = os.path.join(ROOT, "siteguard.db")

os.makedirs(UPLOADS, exist_ok=True)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

ALLOWED = {"jpg", "jpeg", "png", "webp", "mp4", "webm"}

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS incidents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id TEXT NOT NULL,
                location TEXT NOT NULL,
                incident TEXT NOT NULL,
                priority TEXT DEFAULT 'HIGH',
                status TEXT DEFAULT 'OPEN',
                photo TEXT,
                action_plan TEXT,
                created_at TEXT NOT NULL
            )
        """)

def save_incident(worker, location, incident, photo=None):
    with connect() as db:
        cur = db.execute("""
            INSERT INTO incidents
            (worker_id, location, incident, priority, status,
             photo, action_plan, created_at)
            VALUES (?, ?, ?, 'HIGH', 'OPEN', ?,
                    'Supervisor inspection required', ?)
        """, (
            worker, location, incident, photo,
            datetime.now().isoformat(timespec="seconds")
        ))
        return cur.lastrowid

@app.route("/")
def home():
    return send_from_directory(ROOT, "index.html")

@app.route("/<path:name>")
def frontend(name):
    allowed = {
        "index.html", "style.css", "script.js",
        "manifest.json", "sw.js"
    }
    if name in allowed:
        return send_from_directory(ROOT, name)
    return jsonify(error="File not found"), 404

@app.route("/api/health")
def health():
    return jsonify(status="online", app="SiteGuard AI")

@app.route("/api/dashboard")
def dashboard():
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM incidents ORDER BY id DESC LIMIT 20"
        ).fetchall()
        open_count = db.execute(
            "SELECT COUNT(*) FROM incidents WHERE status='OPEN'"
        ).fetchone()[0]

    incidents = [dict(row) for row in rows]
    violations = sum(
        1 for item in incidents
        if "ppe" in item["incident"].lower()
        or "helmet" in item["incident"].lower()
        or "vest" in item["incident"].lower()
        or "zone" in item["incident"].lower()
    )
    risk = min(100, open_count * 10 + violations * 5)
    level = "HIGH" if risk >= 60 else "MEDIUM" if risk >= 30 else "LOW"

    return jsonify(
        workers=48,
        open_incidents=open_count,
        risk_score=risk,
        risk_level=level,
        incidents=incidents
    )

@app.route("/api/incidents", methods=["GET", "POST"])
def incidents():
    if request.method == "GET":
        with connect() as db:
            rows = db.execute(
                "SELECT * FROM incidents ORDER BY id DESC"
            ).fetchall()
        return jsonify([dict(row) for row in rows])

    data = request.get_json(silent=True) or {}
    worker = str(data.get("worker_id", "")).strip()
    location = str(data.get("location", "")).strip()
    incident = str(data.get("incident", "")).strip()

    if not worker or not location or not incident:
        return jsonify(error="Fill all incident fields"), 400

    incident_id = save_incident(worker, location, incident)
    return jsonify(success=True, incident_id=incident_id), 201

@app.route("/api/emergency", methods=["POST"])
def emergency():
    worker = request.form.get("worker_id", "").strip()
    location = request.form.get("location", "").strip()
    incident = request.form.get("incident", "").strip()

    if not worker or not location or not incident:
        return jsonify(error="Worker ID, location and incident required"), 400

    photo_name = None
    upload = request.files.get("photo")

    if upload and upload.filename:
        filename = secure_filename(upload.filename)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        if ext not in ALLOWED:
            return jsonify(error="Unsupported photo/video format"), 400

        photo_name = datetime.now().strftime("%Y%m%d%H%M%S%f") + "_" + filename
        upload.save(os.path.join(UPLOADS, photo_name))

    incident_id = save_incident(worker, location, incident, photo_name)

    return jsonify(
        success=True,
        incident_id=incident_id,
        priority="HIGH",
        message="SOS report saved for supervisor",
        ambulance_notified=False
    ), 201

@app.route("/api/incidents/<int:incident_id>/resolve", methods=["PATCH"])
def resolve(incident_id):
    with connect() as db:
        cur = db.execute(
            "UPDATE incidents SET status='RESOLVED' WHERE id=?",
            (incident_id,)
        )

    if cur.rowcount == 0:
        return jsonify(error="Incident not found"), 404

    return jsonify(success=True, message="Incident resolved")

@app.errorhandler(413)
def too_large(error):
    return jsonify(error="File exceeds 20 MB"), 413

if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True)
