# BoondAI — Assistant BoondManager

## Installation (2 minutes)

### 1. Vérifier Node.js
```
node --version
```
Si Node.js n'est pas installé → https://nodejs.org (télécharger la version LTS)

### 2. Placer les fichiers
Mettez `server.js` et `index.html` dans le même dossier, par exemple :
```
C:\Users\VotreNom\boondai\
  ├── server.js
  ├── index.html
  └── .env
```

### 3. Créer le fichier .env
Créez un fichier `.env` dans le dossier avec votre clé Anthropic :
```
ANTHROPIC_API_KEY=sk-ant-votre-cle-ici
```
Vous trouvez votre clé sur : https://console.anthropic.com/settings/keys

### 4. Lancer le serveur
Ouvrez un terminal dans le dossier et tapez :
```
node -r dotenv/config server.js
```

Si dotenv n'est pas installé :
```
npm install dotenv
node -r dotenv/config server.js
```

Ou sous Windows, sans dotenv, définissez la variable manuellement :
```
set ANTHROPIC_API_KEY=sk-ant-votre-cle
node server.js
```

### 5. Ouvrir l'app
Allez sur **http://localhost:3000** dans votre navigateur.

---

## Première connexion
1. Email → votre email
2. Mot de passe → choisissez un mot de passe BoondAI (1 maj + 1 chiffre + 1 symbole + 8 car. min)
3. Entrez vos 3 tokens BoondManager :
   - **User Token** → Profil → Configuration → API
   - **Client Token** → Administration → Espace développeur → API/Sandbox
   - **Client Key** → Administration → Espace développeur → API/Sandbox

## Connexions suivantes
Email pré-rempli + mot de passe = connecté en 1 seconde.

---

## Exemples de questions
- "Combien de ressources actives ?"
- "Liste des projets en cours"
- "Factures impayées ce mois"
- "Qui n'a pas saisi ses temps cette semaine ?"
- "Derniers contacts ajoutés dans le CRM"
