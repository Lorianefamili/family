require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
} catch(e) {
  console.error('Erreur parsing FIREBASE_KEY:', e.message);
  process.exit(1);
}

// Init Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Init Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { 
  polling: {
    autoStart: false,
    interval: 2000
  }
});

bot.deleteWebHook().then(() => {
  bot.startPolling();
  console.log('✅ Polling démarré proprement');
});

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const POINTS_PAR_PUB = parseInt(process.env.POINTS_PAR_PUB) || 10;
const MINI_APP_URL = process.env.MINI_APP_URL;

// ─────────────────────────────────────────────
// COMMANDE /start
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;

  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    await userRef.set({
      userId,
      username,
      points: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  bot.sendMessage(userId, `👋 Bienvenue ${username} !\n\nGagne des points en regardant des pubs et dépense-les dans la boutique pour débloquer des contenus exclusifs.`, {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🚀 Ouvrir la boutique',
          web_app: { url: MINI_APP_URL }
        }
      ]]
    }
  });
});

// ─────────────────────────────────────────────
// COMMANDE /points
// ─────────────────────────────────────────────
bot.onText(/\/points/, async (msg) => {
  const userId = msg.from.id;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return bot.sendMessage(userId, '❌ Tu n\'es pas encore inscrit. Tape /start pour commencer.');
  }

  const points = userDoc.data().points || 0;
  bot.sendMessage(userId, `💰 Tu as actuellement *${points} points*.`, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// COMMANDE /addcontent (ADMIN)
// ─────────────────────────────────────────────
bot.onText(/\/addcontent/, async (msg) => {
  const userId = msg.from.id;
  if (userId !== ADMIN_ID) return bot.sendMessage(userId, '❌ Commande réservée à l\'admin.');

  bot.sendMessage(userId, '📸 Envoie-moi la photo ou vidéo à ajouter au catalogue.');

  bot.once('message', async (mediaMsg) => {
    if (mediaMsg.from.id !== ADMIN_ID) return;

    let fileId = null;
    let type = null;

    if (mediaMsg.photo) {
      fileId = mediaMsg.photo[mediaMsg.photo.length - 1].file_id;
      type = 'photo';
    } else if (mediaMsg.video) {
      fileId = mediaMsg.video.file_id;
      type = 'video';
    } else {
      return bot.sendMessage(ADMIN_ID, '❌ Envoie uniquement une photo ou une vidéo.');
    }

    bot.sendMessage(ADMIN_ID, '✏️ Donne un titre, un prix et une catégorie séparés par une virgule.\nEx: Photo plage, 50, photo\n\nCatégories: photo / video / premium');

    bot.once('message', async (infoMsg) => {
      if (infoMsg.from.id !== ADMIN_ID) return;

      const parts = infoMsg.text.split(',');
      if (parts.length < 3) return bot.sendMessage(ADMIN_ID, '❌ Format incorrect. Ex: Photo plage, 50, photo');

      const title = parts[0].trim();
      const price = parseInt(parts[1].trim());
      const category = parts[2].trim().toLowerCase();

      if (isNaN(price)) return bot.sendMessage(ADMIN_ID, '❌ Le prix doit être un nombre.');
      if (!['photo', 'video', 'premium'].includes(category)) {
        return bot.sendMessage(ADMIN_ID, '❌ Catégorie invalide. Choisis: photo / video / premium');
      }

      await db.collection('content').add({
        title, price, fileId, type, category,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      bot.sendMessage(ADMIN_ID, `✅ Contenu ajouté !\n📌 Titre: ${title}\n💰 Prix: ${price} points\n📁 Catégorie: ${category}`);
    });
  });
});

// ─────────────────────────────────────────────
// COMMANDE /deletecontent (ADMIN)
// ─────────────────────────────────────────────
bot.onText(/\/deletecontent/, async (msg) => {
  const userId = msg.from.id;
  if (userId !== ADMIN_ID) return bot.sendMessage(userId, '❌ Commande réservée à l\'admin.');

  const snap = await db.collection('content').get();
  
  if (snap.empty) return bot.sendMessage(userId, '❌ Aucun contenu dans la boutique.');

  let liste = '🗑️ Quel contenu supprimer ? Réponds avec le numéro :\n\n';
  const items = [];
  snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
  items.forEach((item, index) => {
    liste += `${index + 1}. ${item.title} — ${item.price} pts\n`;
  });

  bot.sendMessage(userId, liste);

  bot.once('message', async (replyMsg) => {
    if (replyMsg.from.id !== ADMIN_ID) return;

    const choix = parseInt(replyMsg.text) - 1;
    if (isNaN(choix) || choix < 0 || choix >= items.length) {
      return bot.sendMessage(userId, '❌ Numéro invalide.');
    }

    const item = items[choix];
    await db.collection('content').doc(item.id).delete();
    bot.sendMessage(userId, `✅ "${item.title}" supprimé de la boutique !`);
  });
});

// ─────────────────────────────────────────────
// COMMANDE /stats (ADMIN)
// ─────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  if (userId !== ADMIN_ID) return;

  const usersSnap = await db.collection('users').get();
  const contentSnap = await db.collection('content').get();
  const purchasesSnap = await db.collection('purchases').get();

  let totalPoints = 0;
  usersSnap.forEach(doc => { totalPoints += doc.data().points || 0; });

  bot.sendMessage(ADMIN_ID,
    `📊 *Statistiques*\n\n👥 Utilisateurs: ${usersSnap.size}\n🖼️ Contenus: ${contentSnap.size}\n🛍️ Achats: ${purchasesSnap.size}\n💰 Points en circulation: ${totalPoints}`,
    { parse_mode: 'Markdown' }
  );
});

// ─────────────────────────────────────────────
// EXPRESS + API
// ─────────────────────────────────────────────
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const path = require('path');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Créditer des points après pub
app.post('/reward', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId manquant' });

  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  const userData = userDoc.data();

  const now = Date.now();
  const lastAd = userData.lastAd ? userData.lastAd.toMillis() : 0;
  const diff = now - lastAd;

  if (diff < 30000) {
    const restant = Math.ceil((30000 - diff) / 1000);
    return res.status(400).json({ error: `Attends encore ${restant} secondes !` });
  }

  await userRef.update({
    points: admin.firestore.FieldValue.increment(POINTS_PAR_PUB),
    lastAd: admin.firestore.Timestamp.now()
  });

  const updatedDoc = await userRef.get();
  const newPoints = updatedDoc.data().points;

  bot.sendMessage(userId, `🎉 Tu as gagné *${POINTS_PAR_PUB} points* !\n💰 Total: *${newPoints} points*`, { parse_mode: 'Markdown' });
  res.json({ success: true, points: newPoints });
});

// Récupérer les infos utilisateur
app.get('/user/:userId', async (req, res) => {
  const userRef = db.collection('users').doc(req.params.userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(userDoc.data());
});

// Récupérer le catalogue
app.get('/catalogue', async (req, res) => {
  const snap = await db.collection('content').orderBy('createdAt', 'desc').get();
  const items = [];
  snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
  res.json(items);
});

// Acheter un contenu
app.post('/buy', async (req, res) => {
  const { userId, contentId } = req.body;
  if (!userId || !contentId) return res.status(400).json({ error: 'Paramètres manquants' });

  const purchaseRef = db.collection('purchases').doc(`${userId}_${contentId}`);
  const purchaseDoc = await purchaseRef.get();
  if (purchaseDoc.exists) return res.status(400).json({ error: 'Déjà acheté' });

  const contentRef = db.collection('content').doc(contentId);
  const contentDoc = await contentRef.get();
  if (!contentDoc.exists) return res.status(404).json({ error: 'Contenu introuvable' });

  const content = contentDoc.data();
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const userPoints = userDoc.data().points || 0;
  if (userPoints < content.price) return res.status(400).json({ error: 'Points insuffisants' });

  await userRef.update({ points: admin.firestore.FieldValue.increment(-content.price) });
  await purchaseRef.set({
    userId, contentId, title: content.title,
    purchasedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  if (content.type === 'photo') {
    await bot.sendPhoto(userId, content.fileId, { caption: `✅ Tu as débloqué : *${content.title}*`, parse_mode: 'Markdown' });
  } else if (content.type === 'video') {
    await bot.sendVideo(userId, content.fileId, { caption: `✅ Tu as débloqué : *${content.title}*`, parse_mode: 'Markdown' });
  }

  const updatedUser = await userRef.get();
  res.json({ success: true, points: updatedUser.data().points });
});

// Récupérer les achats d'un user
app.get('/purchases/:userId', async (req, res) => {
  const snap = await db.collection('purchases').where('userId', '==', req.params.userId).get();
  const purchases = [];
  snap.forEach(doc => purchases.push({ id: doc.id, ...doc.data() }));
  res.json(purchases);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
  console.log('🤖 Bot démarré...');
});
