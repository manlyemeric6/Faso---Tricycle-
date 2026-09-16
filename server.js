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

function maintenant() {
  return new Date().toLocaleString("fr-FR", {
    timeZone: "Africa/Ouagadougou"
  });
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
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   DEMANDES
========================= */

app.get("/api/demandes", (req, res) => {
  res.json(lire(DEMANDES));
});

app.post("/api/demandes", (req, res) => {
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
    destinationLng = null
  } = req.body;

  if (!depart || !destination) {
    return res.status(400).json({
      erreur: "Départ et destination obligatoires."
    });
  }

  let distance = Number(kilometres) || 0;

  if (
    coordonneeValide(
      departLat,
      departLng
    ) &&
    coordonneeValide(
      destinationLat,
      destinationLng
    )
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

    tarif,

    client: String(client || "Client").trim(),

    telephone: String(telephone || "").trim(),

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

  const demandes = lire(DEMANDES);

  demandes.unshift(demande);

  ecrire(DEMANDES, demandes);

  res.json({
    ok: true,
    demande
  });
});

/* =========================
   CALCUL TARIF
========================= */

app.post("/api/calcul-tarif", (req, res) => {
  const {
    departLat,
    departLng,
    destinationLat,
    destinationLng
  } = req.body;

  if (
    !coordonneeValide(departLat, departLng) ||
    !coordonneeValide(destinationLat, destinationLng)
  ) {
    return res.status(400).json({
      erreur: "Coordonnées GPS invalides."
    });
  }

  const distance = distanceKm(
    departLat,
    departLng,
    destinationLat,
    destinationLng
  );

  res.json({
    ok: true,
    distanceKm: Number(distance.toFixed(2)),
    tarif: tarifAutomatique(distance),
    typeDistance: "à vol d’oiseau"
  });
});

/* =========================
   CONDUCTEURS
========================= */

app.get("/api/conducteurs", (req, res) => {
  res.json(lire(CONDUCTEURS));
});

app.post(
  "/api/conducteurs",
  upload.fields([
    { name: "cnibRecto", maxCount: 1 },
    { name: "cnibVerso", maxCount: 1 },
    { name: "plaquePhoto", maxCount: 1 }
  ]),
  async (req, res) => {

    const {
      nom,
      telephone,
      zone,
      latitude = null,
      longitude = null,
      cnib,
      plaque
    } = req.body;

    if (!nom || !telephone) {
      return res.status(400).json({
        erreur: "Nom et téléphone obligatoires."
      });
    }

    if (!cnib || !plaque) {
      return res.status(400).json({
        erreur: "Numéro CNIB/CNI et numéro de plaque obligatoires."
      });
    }

    const fichiers = req.files || {};

    const cnibRecto = fichiers.cnibRecto?.[0];
    const cnibVerso = fichiers.cnibVerso?.[0];
    const plaquePhoto = fichiers.plaquePhoto?.[0];

    if (!cnibRecto || !cnibVerso || !plaquePhoto) {
      return res.status(400).json({
        erreur: "Les photos CNIB/CNI recto, verso et plaque sont obligatoires."
      });
    }

    const conducteurs = lire(CONDUCTEURS);
    const tel = String(telephone).trim();

    const existe = conducteurs.find(
      c => String(c.telephone || "").trim() === tel
    );

    if (existe) {
      return res.status(409).json({
        erreur: "Ce numéro de téléphone est déjà enregistré comme conducteur.",
        conducteur: existe
      });
    }

    try {

      const recto = await envoyerCloudinary(
        cnibRecto.buffer,
        "faso-tricycle/conducteurs"
      );

      const verso = await envoyerCloudinary(
        cnibVerso.buffer,
        "faso-tricycle/conducteurs"
      );

      const plaqueImage = await envoyerCloudinary(
        plaquePhoto.buffer,
        "faso-tricycle/conducteurs"
      );

      const gpsOK = coordonneeValide(latitude, longitude);

      const conducteur = {
        id: Date.now(),
        nom: String(nom).trim(),
        telephone: tel,
        zone: String(zone || "").trim(),

        cnib: String(cnib).trim(),
        cnibRectoUrl: recto.secure_url,
        cnibVersoUrl: verso.secure_url,

        numeroPlaque: String(plaque).trim(),
        plaquePhotoUrl: plaqueImage.secure_url,

        latitude: gpsOK ? Number(latitude) : null,
        longitude: gpsOK ? Number(longitude) : null,

        statut: "Indisponible",
        statutVerification: "En attente de vérification",

        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      conducteurs.unshift(conducteur);
      ecrire(CONDUCTEURS, conducteurs);

      res.json({
        ok: true,
        message: "Dossier conducteur envoyé pour vérification.",
        conducteur
      });

    } catch (error) {

      console.error(
        "Erreur Cloudinary conducteur :",
        error
      );

      res.status(500).json({
        erreur: "Impossible d'envoyer les documents. Veuillez réessayer."
      });
    }
  }
);;


/* =========================
   VERIFICATION CONDUCTEUR
========================= */

app.patch("/api/conducteurs/:id/verification", (req, res) => {

  const id = Number(req.params.id);
  const statutVerification = String(
    req.body.statutVerification || ""
  ).trim();

  const statutsAutorises = [
    "Vérifié",
    "Refusé"
  ];

  if (!statutsAutorises.includes(statutVerification)) {
    return res.status(400).json({
      erreur: "Statut de vérification invalide."
    });
  }

  const conducteurs = lire(CONDUCTEURS);

  const index = conducteurs.findIndex(
    c => Number(c.id) === id
  );

  if (index === -1) {
    return res.status(404).json({
      erreur: "Conducteur introuvable."
    });
  }

  conducteurs[index].statutVerification =
    statutVerification;

  conducteurs[index].updatedAt = Date.now();

  if (statutVerification === "Refusé") {
    conducteurs[index].statut = "Indisponible";
  }

  ecrire(CONDUCTEURS, conducteurs);

  res.json({
    ok: true,
    message:
      statutVerification === "Vérifié"
        ? "Conducteur vérifié avec succès."
        : "Dossier conducteur refusé.",
    conducteur: conducteurs[index]
  });

});


/* =========================
   POSITION CONDUCTEUR
========================= */

app.patch("/api/conducteurs/:id/position", (req, res) => {
  const id = Number(req.params.id);

  const {
    latitude,
    longitude
  } = req.body;

  if (!coordonneeValide(latitude, longitude)) {
    return res.status(400).json({
      erreur: "Coordonnées GPS invalides."
    });
  }

  const conducteurs = lire(CONDUCTEURS);

  const conducteur = conducteurs.find(
    c => Number(c.id) === id
  );

  if (!conducteur) {
    return res.status(404).json({
      erreur: "Conducteur introuvable."
    });
  }

  conducteur.latitude = Number(latitude);
  conducteur.longitude = Number(longitude);
  conducteur.updatedAt = Date.now();

  ecrire(CONDUCTEURS, conducteurs);

  res.json({
    ok: true,
    conducteur
  });
});

/* =========================
   ATTRIBUTION MANUELLE
========================= */

app.post("/api/assigner", (req, res) => {
  const demandeId = Number(req.body.demandeId);
  const conducteurId = Number(req.body.conducteurId);

  const demandes = lire(DEMANDES);
  const conducteurs = lire(CONDUCTEURS);

  const demande = demandes.find(
    d => Number(d.id) === demandeId
  );

  const conducteur = conducteurs.find(
    c => Number(c.id) === conducteurId
  );

  if (!demande) {
    return res.status(404).json({
      erreur: "Demande introuvable."
    });
  }

  if (!conducteur) {
    return res.status(404).json({
      erreur: "Conducteur introuvable."
    });
  }

  if (conducteur.statut !== "Disponible") {
    return res.status(400).json({
      erreur: "Ce conducteur n'est plus disponible."
    });
  }

  demande.conducteurId = conducteur.id;
  demande.conducteur = conducteur.nom;
  demande.telephoneConducteur = conducteur.telephone;
  demande.statut = "Conducteur attribué";

  if (
    coordonneeValide(
      demande.departLat,
      demande.departLng
    ) &&
    coordonneeValide(
      conducteur.latitude,
      conducteur.longitude
    )
  ) {
    demande.distanceConducteur = Number(
      distanceKm(
        demande.departLat,
        demande.departLng,
        conducteur.latitude,
        conducteur.longitude
      ).toFixed(2)
    );
  }

  demande.updatedAt = Date.now();

  conducteur.statut = "En course";
  conducteur.updatedAt = Date.now();

  ecrire(DEMANDES, demandes);
  ecrire(CONDUCTEURS, conducteurs);

  res.json({
    ok: true,
    demande,
    conducteur
  });
});

/* =========================
   CONDUCTEUR LE PLUS PROCHE
========================= */

app.get("/api/demandes/:id/conducteur-proche", (req, res) => {
  const id = Number(req.params.id);

  const demandes = lire(DEMANDES);
  const conducteurs = lire(CONDUCTEURS);

  const demande = demandes.find(
    d => Number(d.id) === id
  );

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

app.post("/api/assigner-automatique", (req, res) => {
  const demandeId = Number(req.body.demandeId);

  const demandes = lire(DEMANDES);
  const conducteurs = lire(CONDUCTEURS);

  const demande = demandes.find(
    d => Number(d.id) === demandeId
  );

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

  ecrire(DEMANDES, demandes);
  ecrire(CONDUCTEURS, conducteurs);

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

app.patch("/api/demandes/:id", (req, res) => {
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

  const demandes = lire(DEMANDES);
  const conducteurs = lire(CONDUCTEURS);

  const demande = demandes.find(
    d => Number(d.id) === id
  );

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
  ecrire(CONDUCTEURS, conducteurs);

  res.json({
    ok: true,
    demande
  });
});

/* =========================
   DASHBOARD
========================= */

app.get("/api/dashboard", (req, res) => {
  const demandes = lire(DEMANDES);
  const conducteurs = lire(CONDUCTEURS);

  const chiffreAffaires = demandes
    .filter(d => d.statut === "Terminée")
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
