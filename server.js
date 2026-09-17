const { Pool } = require("pg");

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const cloudinary = require("cloudinary").v2;
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const express = require("express");
const fs = require("fs");
const path = require("path");

function envoyerCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

const app = express();
app.use(require("cors")({ origin: true }));
const crypto = require("crypto");

const sessionsAdmin = new Map();

const PORT = process.env.PORT || 3000;

async function initialiserPostgreSQL() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conducteurs (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS demandes (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS utilisateurs (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("PostgreSQL : tables prêtes.");
}

const DATA = path.join(__dirname, "data");
const DEMANDES = path.join(DATA, "demandes.json");
const CONDUCTEURS = path.join(DATA, "conducteurs.json");

if (!fs.existsSync(DATA)) {
  fs.mkdirSync(DATA, { recursive: true });
}

function initFile(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "[]");
  }
}

initFile(DEMANDES);
initFile(CONDUCTEURS);

function lire(file) {
  try {
    const contenu = fs.readFileSync(file, "utf8");
    const data = JSON.parse(contenu);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function ecrire(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}


async function lireConducteursDB() {
  if (!pool) return lire(CONDUCTEURS);

  const result = await pool.query(
    "SELECT data FROM conducteurs ORDER BY created_at DESC"
  );

  return result.rows.map(row => row.data);
}

async function enregistrerConducteurDB(conducteur) {
  if (!pool) {
    const conducteurs = lire(CONDUCTEURS);
    conducteurs.unshift(conducteur);
    ecrire(CONDUCTEURS, conducteurs);
    return;
  }
  await pool.query(
    `INSERT INTO conducteurs (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [conducteur.id, JSON.stringify(conducteur)]
  );
}

function maintenant() {
  return new Date().toLocaleString("fr-FR", {
    timeZone: "Africa/Ouagadougou"
  });
}

async function lireDemandesDB() {
  if (!pool) return lire(DEMANDES);

  const result = await pool.query(
    "SELECT data FROM demandes ORDER BY created_at DESC"
  );

  return result.rows.map(row => row.data);
}

async function enregistrerDemandeDB(demande) {
  if (!pool) {
    const demandes = lire(DEMANDES);
    demandes.unshift(demande);
    ecrire(DEMANDES, demandes);
    return;
  }

  await pool.query(
    `INSERT INTO demandes (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [demande.id, JSON.stringify(demande)]
  );
}

function nombreValide(value) {
  const n = Number(value);
  return Number.isFinite(n);
}

function coordonneeValide(lat, lng) {
  return (
    nombreValide(lat) &&
    nombreValide(lng) &&
    Number(lat) >= -90 &&
    Number(lat) <= 90 &&
    Number(lng) >= -180 &&
    Number(lng) <= 180
  );
}

/*
 * Distance GPS à vol d'oiseau — formule de Haversine.
 * Ce n'est pas encore la distance routière.
 */
function distanceKm(lat1, lng1, lat2, lng2) {
  if (
    !coordonneeValide(lat1, lng1) ||
    !coordonneeValide(lat2, lng2)
  ) {
    return 0;
  }

  const R = 6371;
  const dLat = (Number(lat2) - Number(lat1)) * Math.PI / 180;
  const dLng = (Number(lng2) - Number(lng1)) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(Number(lat1) * Math.PI / 180) *
    Math.cos(Number(lat2) * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculerTarif(trajet, km) {
  const distance = Number(km) || 0;

  if (trajet === "court") {
    return 3000;
  }

  if (trajet === "moyen") {
    return 5000;
  }

  if (trajet === "long") {
    return Math.max(5000, Math.ceil(distance) * 500);
  }

  return distance > 10
    ? Math.max(5000, Math.ceil(distance) * 500)
    : 3000;
}

function tarifAutomatique(km) {
  const distance = Number(km) || 0;

  if (distance <= 5) {
    return 3000;
  }

  if (distance <= 10) {
    return 5000;
  }

  return Math.max(5000, Math.ceil(distance) * 500);
}

function conducteurLePlusProche(demande, conducteurs) {
  if (
    !coordonneeValide(demande.departLat, demande.departLng)
  ) {
    return null;
  }

  const disponibles = conducteurs
    .filter(c =>
      c.statut === "Disponible" &&
      c.statutVerification === "Vérifié" &&
      coordonneeValide(c.latitude, c.longitude)
    )
    .map(c => ({
      conducteur: c,
      distance: distanceKm(
        demande.departLat,
        demande.departLng,
        c.latitude,
        c.longitude
      )
    }))
    .sort((a, b) => a.distance - b.distance);

  return disponibles.length ? disponibles[0] : null;
}


app.use(express.json({ limit: "10mb" }));

app.post("/api/admin/login", (req, res) => {
  const secret = String(req.body.secret || "");

  if (
    !process.env.ADMIN_SECRET ||
    secret !== process.env.ADMIN_SECRET
  ) {
    return res.status(401).json({
      erreur: "Identifiants administrateur incorrects."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  sessionsAdmin.set(token, {
    createdAt: Date.now()
  });

  res.json({
    ok: true,
    token
  });
});

function verifierAdmin(req, res, next) {
  const authorization = String(
    req.headers.authorization || ""
  );

  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  const session = sessionsAdmin.get(token);

  if (!session) {
    return res.status(401).json({
      erreur: "Session administrateur invalide ou expirée."
    });
  }

  next();
}

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/calcul-tarif", (req, res) => {
  try {
    const departLat = Number(req.body.departLat);
    const departLng = Number(req.body.departLng);
    const destinationLat = Number(req.body.destinationLat);
    const destinationLng = Number(req.body.destinationLng);

    if (
      !Number.isFinite(departLat) ||
      !Number.isFinite(departLng) ||
      !Number.isFinite(destinationLat) ||
      !Number.isFinite(destinationLng) ||
      !coordonneeValide(departLat, departLng) ||
      !coordonneeValide(destinationLat, destinationLng)
    ) {
      return res.status(400).json({
        ok: false,
        erreur: "Coordonnées GPS invalides."
      });
    }

    const distance = distanceKm(
      departLat,
      departLng,
      destinationLat,
      destinationLng
    );

    let tarif;

    if (distance <= 5) {
      tarif = 3000;
    } else if (distance <= 10) {
      tarif = 5000;
    } else {
      tarif = Math.max(5000, Math.ceil(distance) * 500);
    }

    const fraisClient = Math.round(tarif * 0.05);
    const totalClient = tarif + fraisClient;
    const commission = Math.round(tarif * 0.10);
    const revenuConducteur = tarif - commission;

    res.json({
      ok: true,
      distanceKm: Number(distance.toFixed(2)),
      tarif,
      fraisClient,
      totalClient,
      commission,
      revenuConducteur
    });

  } catch (error) {
    console.error("Erreur calcul tarif :", error);

    res.status(500).json({
      ok: false,
      erreur: "Erreur pendant le calcul du tarif."
    });
  }
});

app.get("/api/conducteurs", async (req, res) => {
  try {
    const conducteurs = await lireConducteursDB();
    res.json({ ok: true, conducteurs });
  } catch (error) {
    console.error("Erreur lecture conducteurs :", error);
    res.status(500).json({ ok: false, erreur: "Erreur lors de la lecture des conducteurs." });
  }
});

/* =========================
   DEMANDES
========================= */

app.get("/api/demandes", async (req, res) => {
  res.json(await lireDemandesDB());
});

app.post("/api/demandes", async (req, res) => {
  const {
    depart,
    destination,
    client,
    telephone,
    trajet = "auto",
    kilometres = 0,
    departLat = null,
    departLng = null,
    destinationLat = null,
    destinationLng = null,
    moyenPaiement = "especes"
  } = req.body;

  if (!depart || !destination) {
    return res.status(400).json({
      erreur: "Départ et destination obligatoires."
    });
  }

  const moyensPaiementAutorises = [
    "especes",
    "orange_money",
    "moov_money",
    "carte"
  ];

  const paiementChoisi = moyensPaiementAutorises.includes(
    String(moyenPaiement)
  )
    ? String(moyenPaiement)
    : "especes";

  let distance = Number(kilometres) || 0;

  if (
    coordonneeValide(departLat, departLng) &&
    coordonneeValide(destinationLat, destinationLng)
  ) {
    distance = distanceKm(
      departLat,
      departLng,
      destinationLat,
      destinationLng
    );
  }

  let tarif;

  if (trajet === "auto") {
    tarif = tarifAutomatique(distance);
  } else {
    tarif = calculerTarif(trajet, distance);
  }

  tarif = Number(tarif) || 0;


  /* =========================
     FINANCES FASO TRICYCLE
     ========================= */

  const fraisClient = Math.round(tarif * 0.05);

  const totalClient = tarif + fraisClient;

  const commissionFasoTricycle = Math.round(tarif * 0.10);

  const revenuConducteur = tarif - commissionFasoTricycle;

  const demande = {
    id: Date.now(),

    depart: String(depart).trim(),
    destination: String(destination).trim(),

    trajet: String(trajet),

    kilometres: Number(distance.toFixed(2)),

    departLat: coordonneeValide(departLat, departLng)
      ? Number(departLat)
      : null,

    departLng: coordonneeValide(departLat, departLng)
      ? Number(departLng)
      : null,

    destinationLat: coordonneeValide(
      destinationLat,
      destinationLng
    )
      ? Number(destinationLat)
      : null,

    destinationLng: coordonneeValide(
      destinationLat,
      destinationLng
    )
      ? Number(destinationLng)
      : null,

    /* Tarif avant frais */
    tarif,

    /* Frais supplémentaires payés par le client */
    fraisClient,

    /* Total réellement payé par le client */
    totalClient,

    /* Commission Faso Tricycle */
    commissionFasoTricycle,

    /* Montant revenant au conducteur */
    revenuConducteur,

    client: String(client || "Client").trim(),

    telephone: String(telephone || "").trim(),

    moyenPaiement: paiementChoisi,

    date: maintenant(),

    statut: "Recherche d’un conducteur",

    conducteurId: null,

    conducteur: "",

    telephoneConducteur: "",

    distanceConducteur: null,

    paiement: "À payer",

    createdAt: Date.now(),

    updatedAt: Date.now()
  };

  const demandes = await lireDemandesDB();

  demandes.push(demande);

  ecrire(DEMANDES, demandes);

  res.json({
    ok: true,
    demande
  });
});



/* =========================
   INSCRIPTION CONDUCTEUR
========================= */

app.post(
  "/api/conducteurs",
  upload.fields([
    { name: "cnibRecto", maxCount: 1 },
    { name: "cnibVerso", maxCount: 1 },
    { name: "plaquePhoto", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const {
        nom,
        telephone,
        zone,
        latitude,
        longitude,
        cnib,
        plaque
      } = req.body;

      if (!nom || !telephone) {
        return res.status(400).json({
          ok: false,
          erreur: "Nom et téléphone obligatoires."
        });
      }

      const lat = Number(latitude);
      const lng = Number(longitude);

      const gpsValide = coordonneeValide(lat, lng);

      const fichiers = req.files || {};

      let cnibRecto = null;
      let cnibVerso = null;
      let plaquePhoto = null;

      if (fichiers.cnibRecto && fichiers.cnibRecto[0]) {
        try {
          const result = await envoyerCloudinary(
            fichiers.cnibRecto[0].buffer,
            "faso-tricycle/conducteurs/cnib"
          );
          cnibRecto = result.secure_url;
        } catch (e) {
          console.log("Cloudinary CNIB recto :", e.message);
        }
      }

      if (fichiers.cnibVerso && fichiers.cnibVerso[0]) {
        try {
          const result = await envoyerCloudinary(
            fichiers.cnibVerso[0].buffer,
            "faso-tricycle/conducteurs/cnib"
          );
          cnibVerso = result.secure_url;
        } catch (e) {
          console.log("Cloudinary CNIB verso :", e.message);
        }
      }

      if (fichiers.plaquePhoto && fichiers.plaquePhoto[0]) {
        try {
          const result = await envoyerCloudinary(
            fichiers.plaquePhoto[0].buffer,
            "faso-tricycle/conducteurs/plaque"
          );
          plaquePhoto = result.secure_url;
        } catch (e) {
          console.log("Cloudinary plaque :", e.message);
        }
      }

      const maintenantTimestamp = Date.now();

      const conducteur = {
        id: maintenantTimestamp,
        nom: String(nom).trim(),
        telephone: String(telephone).trim(),
        zone: String(zone || "").trim(),

        latitude: gpsValide ? lat : null,
        longitude: gpsValide ? lng : null,

        cnib: String(cnib || "").trim(),
        plaque: String(plaque || "").trim(),

        cnibRecto,
        cnibVerso,
        plaquePhoto,

        statut: "Disponible",
        statutVerification: "Vérifié",

        createdAt: maintenantTimestamp,
        updatedAt: maintenantTimestamp
      };

      await enregistrerConducteurDB(conducteur);

      console.log(
        "Conducteur enregistré :",
        conducteur.nom,
        conducteur.latitude,
        conducteur.longitude
      );

      res.json({
        ok: true,
        message: "Conducteur enregistré avec succès.",
        conducteur
      });

    } catch (error) {
      console.error("Erreur inscription conducteur :", error);

      res.status(500).json({
        ok: false,
        erreur: "Erreur lors de l'enregistrement du conducteur."
      });
    }
  }
);


/* =========================
   CONDUCTEUR LE PLUS PROCHE
========================= */

app.get("/api/demandes/:id/conducteur-proche", async (req, res) => {
  const id = Number(req.params.id);

  const demandes = await lireDemandesDB();
  const conducteurs = await lireConducteursDB();
  const demande = demandes.find(d => Number(d.id) === id);

  if (!demande) {
    return res.status(404).json({
      erreur: "Demande introuvable."
    });
  }

  const resultat = conducteurLePlusProche(
    demande,
    conducteurs
  );

  if (!resultat) {
    return res.json({
      ok: true,
      trouve: false,
      message: "Aucun conducteur disponible avec GPS."
    });
  }

  res.json({
    ok: true,
    trouve: true,
    conducteur: resultat.conducteur,
    distanceKm: Number(resultat.distance.toFixed(2))
  });
});


/* =========================
   ATTRIBUTION AUTOMATIQUE
========================= */

app.post("/api/assigner-automatique", async (req, res) => {
  const demandeId = Number(req.body.demandeId);

  const demandes = await lireDemandesDB();
  const conducteurs = await lireConducteursDB();
  const demande = demandes.find(d => Number(d.id) === demandeId);

  if (!demande) {
    return res.status(404).json({
      erreur: "Demande introuvable."
    });
  }

  if (demande.conducteurId) {
    return res.status(400).json({
      erreur: "Cette demande possède déjà un conducteur."
    });
  }

  const resultat = conducteurLePlusProche(
    demande,
    conducteurs
  );

  if (!resultat) {
    return res.status(404).json({
      erreur: "Aucun conducteur disponible avec une position GPS."
    });
  }

  const conducteur = resultat.conducteur;

  demande.conducteurId = conducteur.id;
  demande.conducteur = conducteur.nom;
  demande.telephoneConducteur = conducteur.telephone;
  demande.distanceConducteur = Number(
    resultat.distance.toFixed(2)
  );
  demande.statut = "Conducteur attribué";
  demande.updatedAt = Date.now();

  conducteur.statut = "En course";
  conducteur.updatedAt = Date.now();

  await enregistrerConducteurDB(conducteur);
  res.json({
    ok: true,
    demande,
    conducteur,
    distanceKm: demande.distanceConducteur
  });
  });


/* =========================
   STATUT COURSE
========================= */

app.patch("/api/demandes/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { statut } = req.body;

  const statutsAutorises = [
    "Recherche d’un conducteur",
    "Recherche d'un conducteur",
    "Conducteur attribué",
    "En course",
    "Terminée",
    "Annulée"
  ];

  if (!statutsAutorises.includes(statut)) {
    return res.status(400).json({
      erreur: "Statut invalide."
    });
  }

  const demandes = await lireDemandesDB();
  const conducteurs = await lireConducteursDB();
  const demande = demandes.find(d => Number(d.id) === id);

  if (!demande) {
    return res.status(404).json({
      erreur: "Demande introuvable."
    });
  }

  demande.statut = statut;
  demande.updatedAt = Date.now();

  if (
    (statut === "Terminée" ||
      statut === "Annulée") &&
    demande.conducteurId
  ) {
    const conducteur = conducteurs.find(
      c => Number(c.id) === Number(demande.conducteurId)
    );

    if (conducteur) {
      conducteur.statut = "Disponible";
      conducteur.updatedAt = Date.now();
    }
  }

  if (
    statut === "En course" &&
    demande.conducteurId
  ) {
    const conducteur = conducteurs.find(
      c => Number(c.id) === Number(demande.conducteurId)
    );

    if (conducteur) {
      conducteur.statut = "En course";
      conducteur.updatedAt = Date.now();
    }
  }

  ecrire(DEMANDES, demandes);
  if (demande.conducteurId) { const conducteurDB = conducteurs.find(c => Number(c.id) === Number(demande.conducteurId)); if (conducteurDB) await enregistrerConducteurDB(conducteurDB); }
  res.json({
    ok: true,
    demande
  });
});


/* =========================
   DASHBOARD
========================= */

app.get("/api/dashboard", async (req, res) => {
  const demandes = await lireDemandesDB();
  const conducteurs = await lireConducteursDB();

  const chiffreAffaires = demandes
    .reduce(
      (total, d) =>
        total + Number(d.tarif || 0),
      0
    );

  res.json({
    demandes: demandes.length,

    conducteurs: conducteurs.length,

    disponibles: conducteurs.filter(
      c => c.statut === "Disponible"
    ).length,

    courses: demandes.filter(
      d => d.statut === "En course"
    ).length,

    terminees: demandes.filter(
      d => d.statut === "Terminée"
    ).length,

    annulees: demandes.filter(
      d => d.statut === "Annulée"
    ).length,

    chiffreAffaires
  });
});


/* =========================
   SANTÉ
========================= */

app.get("/api/sante", (req, res) => {
  res.json({
    ok: true,
    application: "Faso Tricycle V3",
    serveur: "actif",
    gps: "supporté",
    heure: maintenant()
  });
});


/* =========================
   PAGE
========================= */

app.use((req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

initialiserPostgreSQL()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("=================================");
      console.log(" Faso Tricycle V3 🇧🇫");
      console.log(" Serveur démarré sur le port " + PORT);
      console.log(" GPS : actif");
      console.log(" Tarif automatique : actif");
      console.log(" Recherche conducteur proche : active");
      console.log("=================================");
    });
  })
  .catch((error) => {
    console.error("Erreur PostgreSQL :", error.message);
    process.exit(1);
  });
