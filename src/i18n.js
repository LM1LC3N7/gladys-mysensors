// -----------------------------------------------------------------------------
// Runtime texts (English and French): device and feature names, the status
// of the integration, the answers of the test button and the command
// refusals. None of them ever carries the password of the broker.
// -----------------------------------------------------------------------------

import { KIND } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'fr' ? value.fr : value.en);

/** "45 s", "5 min", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Texts joined with ". ", in both languages. */
export function join(...parts) {
  const list = parts.filter(Boolean);
  return both(list.map((p) => p.en).join('. '), list.map((p) => p.fr).join('. '));
}

const KIND_NAMES = {
  [KIND.TEMPERATURE]: both('Temperature', 'Température'),
  [KIND.HUMIDITY]: both('Humidity', 'Humidité'),
  [KIND.PRESSURE]: both('Pressure', 'Pression'),
  [KIND.DOOR]: both('Door', 'Ouverture'),
  [KIND.MOTION]: both('Motion', 'Mouvement'),
  [KIND.SMOKE]: both('Smoke', 'Fumée'),
  [KIND.LEAK]: both('Leak', 'Fuite'),
  [KIND.VIBRATION]: both('Vibration', 'Vibration'),
  [KIND.RELAY]: both('Relay', 'Relais'),
  [KIND.STATE]: both('State', 'État'),
  [KIND.LIGHT]: both('Light', 'Lumière'),
  [KIND.BRIGHTNESS]: both('Brightness', 'Luminosité'),
  [KIND.LEVEL]: both('Level', 'Niveau'),
  [KIND.POWER]: both('Power', 'Puissance'),
  [KIND.VOLTAGE]: both('Voltage', 'Tension'),
  [KIND.CURRENT]: both('Current', 'Courant'),
  [KIND.LUX]: both('Light level', 'Éclairement'),
  [KIND.MOISTURE]: both('Moisture', 'Humidité du sol'),
  [KIND.UV]: both('UV index', 'Indice UV'),
  [KIND.DISTANCE]: both('Distance', 'Distance'),
  [KIND.PH]: both('pH', 'pH'),
  [KIND.ORP]: both('ORP', 'Potentiel redox'),
  [KIND.BATTERY]: both('Battery', 'Batterie'),
};

/** "Kitchen - Temperature" (the description the node presented), else "Temperature (child 3)". */
export function kindName(kind, child, description, language) {
  const name = word(KIND_NAMES[kind] ?? both(kind, kind), language);
  if (kind === KIND.BATTERY) return name;
  if (description) return `${description} - ${name}`;
  return language === 'fr' ? `${name} (capteur ${child})` : `${name} (child ${child})`;
}

export function nodeName(id, sketch, language) {
  if (sketch) return language === 'fr' ? `${sketch} (nœud ${id})` : `${sketch} (node ${id})`;
  return language === 'fr' ? `Nœud MySensors ${id}` : `MySensors node ${id}`;
}

const PROBLEMS = {
  'gateway:empty': both(
    'Type the address of the Ethernet gateway',
    'Saisissez l’adresse de la passerelle Ethernet',
  ),
  'gateway:invalid': both(
    'The address of the gateway is not valid (host or IPv4 address, optional :port)',
    'L’adresse de la passerelle n’est pas valide (nom ou adresse IPv4, :port facultatif)',
  ),
  'gateway:scheme': both(
    'Type the address of the gateway without a scheme',
    'Saisissez l’adresse de la passerelle sans préfixe',
  ),
  'gateway:credentials': both(
    'The address of the gateway holds a user name: remove it',
    'L’adresse de la passerelle contient un utilisateur : retirez-le',
  ),
  'broker:empty': both('Type the address of the MQTT broker', 'Saisissez l’adresse du broker MQTT'),
  'broker:invalid': both(
    'The address of the MQTT broker is not valid (host or IPv4 address, optional :port)',
    'L’adresse du broker MQTT n’est pas valide (nom ou adresse IPv4, :port facultatif)',
  ),
  'broker:scheme': both(
    'Only mqtt:// (plain TCP) brokers are supported',
    'Seuls les brokers mqtt:// (TCP simple) sont pris en charge',
  ),
  'broker:credentials': both(
    'Type the user name and the password in their own fields, not in the address',
    'Saisissez l’utilisateur et le mot de passe dans leurs champs, pas dans l’adresse',
  ),
  username: both('The MQTT user name is not valid', 'L’utilisateur MQTT n’est pas valide'),
  password: both(
    'The MQTT password is not valid (256 characters at most, no control character)',
    'Le mot de passe MQTT n’est pas valide (256 caractères au plus, sans caractère de contrôle)',
  ),
  'password-alone': both(
    'An MQTT password needs a user name',
    'Un mot de passe MQTT a besoin d’un utilisateur',
  ),
  prefix: both(
    'A topic prefix is not valid (letters, digits, - _ . and / between levels, no wildcard)',
    'Un préfixe de topic n’est pas valide (caractères alphanumériques, - _ . et / entre niveaux, sans joker)',
  ),
  'same-prefix': both(
    'The two topic prefixes must differ',
    'Les deux préfixes de topic doivent être différents',
  ),
};

export const T = {
  problem: (key) =>
    PROBLEMS[key] ?? both('The configuration is not valid', 'La configuration n’est pas valide'),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys yet; next try in ${wait}`,
      `La configuration n’a pas encore pu être lue depuis Gladys ; prochain essai dans ${wait}`,
    ),
  connecting: (target) => both(`Connecting to ${target}…`, `Connexion à ${target}…`),
  unreachable: (target, reason, wait) =>
    both(
      `${target} unreachable (${reason}); next try in ${wait}`,
      `${target} injoignable (${reason}) ; prochain essai dans ${wait}`,
    ),
  refused: (reason, wait) =>
    both(
      `The MQTT broker refused the connection (${reason}); next try in ${wait}. Save the configuration or use the test button to try now`,
      `Le broker MQTT a refusé la connexion (${reason}) ; prochain essai dans ${wait}. Enregistrez la configuration ou utilisez le bouton de test pour réessayer`,
    ),
  waitingGateway: (target) =>
    both(
      `Connected to ${target}, waiting for the MySensors gateway`,
      `Connecté à ${target}, en attente de la passerelle MySensors`,
    ),
  gatewaySilent: (wait) =>
    both(
      `The MQTT broker is connected but the MySensors gateway has not answered for ${wait}`,
      `Le broker MQTT est connecté mais la passerelle MySensors ne répond plus depuis ${wait}`,
    ),
  connected: (version, nodes) =>
    both(
      `MySensors gateway${version ? ` ${version}` : ''} connected; ${nodes} node(s) heard`,
      `Passerelle MySensors${version ? ` ${version}` : ''} connectée ; ${nodes} nœud(s) entendu(s)`,
    ),
  dataUnreadable: both(
    '/data cannot be read: the stops kept there and the ids handed out are unknown (read again every 10 s)',
    '/data illisible : les arrêts qui y sont gardés et les ids attribués sont inconnus (relu toutes les 10 s)',
  ),
  dataUnwritable: both(
    '/data cannot be written: the stops and the ids handed out would be lost at a restart',
    '/data non inscriptible : les arrêts et les ids attribués seraient perdus au redémarrage',
  ),
  stopsWaiting: (list) =>
    both(
      `Off kept, not sent yet (sent as soon as the gateway is connected): ${list}`,
      `Arrêt gardé, pas encore envoyé (part dès que la passerelle est connectée) : ${list}`,
    ),
  stopsUnconfirmed: (list) =>
    both(
      `Off sent, not confirmed by the node yet (sent again): ${list}`,
      `Arrêt envoyé, pas encore confirmé par le nœud (renvoyé) : ${list}`,
    ),
  stopsAbandoned: (list) =>
    both(
      `Off sent 5 times without any echo of the node: check it (${list})`,
      `Arrêt envoyé 5 fois sans écho du nœud : vérifiez-le (${list})`,
    ),
  invalidSafe: (list) =>
    both(
      `Entries ignored in "Relays and dimmers declared safe": ${list}`,
      `Entrées ignorées dans « Relais et variateurs déclarés sûrs » : ${list}`,
    ),
  idsFull: both(
    'A node asked for an id: 10 ids handed out are still unused, none given (they are given again 5 min after)',
    'Un nœud a demandé un id : 10 ids attribués sont encore inutilisés, aucun donné (redonnés 5 min après)',
  ),
  idsUnsaved: both(
    'A node asked for an id: none given, /data cannot be written',
    'Un nœud a demandé un id : aucun donné, /data non inscriptible',
  ),
  idsOff: both(
    'A node asked for an id: none given ("Hand out node ids" is off)',
    'Un nœud a demandé un id : aucun donné (« Attribuer les ids des nœuds » est désactivé)',
  ),
  dropped: (count) =>
    both(
      `${count} message(s) ignored (malformed, too long or over 200 per second)`,
      `${count} message(s) ignoré(s) (mal formé, trop long ou au-delà de 200 par seconde)`,
    ),
  mqtt311: both('MQTT 3.1.1 broker', 'Broker MQTT 3.1.1'),
};

export const TEST = {
  ok: (version, nodes) =>
    both(
      `Gateway answered: MySensors ${version || '(version not given)'}; ${nodes} node(s) heard`,
      `La passerelle a répondu : MySensors ${version || '(version non donnée)'} ; ${nodes} nœud(s) entendu(s)`,
    ),
  noConfig: both('The configuration could not be read', 'La configuration n’a pas pu être lue'),
  silent: both(
    'Connected, but the MySensors gateway did not answer within 10 s',
    'Connecté, mais la passerelle MySensors n’a pas répondu en 10 s',
  ),
};

export const ERRORS = {
  unknownFeature: both('Unknown MySensors feature', 'Fonction MySensors inconnue'),
  badValue: both('Value not accepted by this feature', 'Valeur refusée par cette fonction'),
  noConfig: both(
    'Nothing sent: the configuration is not read yet',
    'Rien envoyé : la configuration n’est pas encore lue',
  ),
  notSafe: (target) =>
    both(
      `Nothing sent: ${target} is not in "Relays and dimmers declared safe" (turning off is always allowed)`,
      `Rien envoyé : ${target} n’est pas dans « Relais et variateurs déclarés sûrs » (éteindre reste toujours permis)`,
    ),
  otherType: (target) =>
    both(
      `Nothing sent: the node now presents ${target} as another kind of sensor; scan and update the device`,
      `Rien envoyé : le nœud présente maintenant ${target} comme un autre type de capteur ; relancez la découverte et mettez à jour l’appareil`,
    ),
  offline: both(
    'Nothing sent: the MySensors gateway is not connected',
    'Rien envoyé : la passerelle MySensors n’est pas connectée',
  ),
};

/** "12:1" for the stops lists, at most 5 of them. */
export const targetList = (targets) =>
  targets.length > 5 ? `${targets.slice(0, 5).join(', ')}…` : targets.join(', ');
