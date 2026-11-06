# MySensors

Lit les nœuds de votre réseau [MySensors](https://www.mysensors.org) et
commande les relais et variateurs que vous déclarez sûrs, via **votre
passerelle** sur votre réseau local :

- une **passerelle Ethernet** (W5100, ENC28J60, ESP8266...) : Gladys s'y
  connecte, port TCP 5003 par défaut ;
- ou une **passerelle MQTT** et votre broker MQTT (Mosquitto...), MQTT simple
  (TCP).

Les passerelles série (USB) ne sont pas prises en charge. Rien ne passe par
Internet.

Intégration non officielle, sans lien avec le projet MySensors, jamais
testée avec un vrai appareil : elle a été construite d'après le protocole
série 2.x publié et pymysensors, la bibliothèque de Home Assistant, et testée
contre des passerelles simulées. Dites-nous ce qui marche et ce qui
ne marche pas.

## Sécurité

Le protocole MySensors n'a ni mot de passe ni protection sur le réseau :
n'importe qui sur votre réseau peut parler à la passerelle. À utiliser sur un
réseau de confiance seulement. Le mot de passe MQTT est gardé par Gladys dans
sa base, jamais réaffiché, envoyé seulement à votre broker.

## Mise en route

1. Choisissez le type de passerelle.
2. Ethernet : saisissez son adresse (`192.168.1.50`, ou `192.168.1.50:5004`
   pour un autre port). MQTT : saisissez l'adresse du broker, l'utilisateur
   et le mot de passe s'il en demande, et les deux préfixes de topic du
   sketch de la passerelle (`MY_MQTT_PUBLISH_TOPIC_PREFIX`, `mygateway1-out`
   par défaut, et `MY_MQTT_SUBSCRIBE_TOPIC_PREFIX`, `mygateway1-in` par
   défaut).
3. Enregistrez, puis **Tester la connexion** : la passerelle répond avec sa
   version.
4. Ouvrez l'onglet **Découverte** : les nœuds apparaissent quand ils se
   présentent (à leur démarrage, ou après une découverte pour ceux qui sont
   éveillés). Ajoutez-les.

## Ce qui est lu

Un appareil Gladys par nœud (nom de son sketch et id du nœud), une fonction
par valeur d'un capteur : température (°C), humidité, pression (hPa),
ouverture (ouvert / fermé), mouvement, fumée, fuite, vibration, éclairement
(lux), humidité du sol, puissance (W), tension, courant, indice UV, distance
(cm), pH, potentiel redox, la batterie du nœud, et l'état marche/arrêt et le
niveau des relais, variateurs, chauffages et arrosages. Gladys répond aux
nœuds avec le système métrique : un sketch qui envoie des °F, des pouces ou
d'autres unités est lu comme s'il était métrique.

Les valeurs sont publiées dès leur arrivée. Une valeur qui n'est pas un
nombre, vide ou hors plage est ignorée, jamais publiée comme 0. Un message
gardé par le broker MQTT (retained) peut être ancien : il est ignoré.

Volets, thermostats, lumières RGB, compteurs d'énergie (kWh), contrôleurs de
scène, serrures et IR ne sont pas pris en charge dans cette version.

## Relais et variateurs

Un relais ou un variateur peut alimenter n'importe quoi (une lampe, mais
aussi une pompe, un chauffage, un congélateur, une porte de garage), et un
« tout éteindre / tout allumer » d'un assistant vocal ou d'une scène touche
chaque interrupteur et chaque lumière. Un relais (`S_BINARY`) ou un
variateur (`S_DIMMER`) est donc seulement affiché, en lecture seule, tant que
vous ne le déclarez pas sûr dans **Relais et variateurs déclarés sûrs** avec
son couple `nœud:capteur` (par exemple `12:1, 12:2`). Il devient alors un
interrupteur ou une lumière (marche/arrêt et luminosité). Après avoir changé
la liste, relancez la découverte et mettez à jour l'appareil dans l'onglet
Découverte. Chauffages et arrosages ne sont jamais commandés.

Une commande part avec le drapeau d'écho de MySensors : elle est confirmée
quand le nœud la renvoie en écho (sa radio l'a reçue) ; un état signalé par
le nœud ne confirme pas la commande. Sans écho en 3,5 s, elle est « envoyée, sans
confirmation ». L'état affiché dans Gladys est celui que le nœud signale (un
écho prouve seulement que le nœud a reçu la commande) : un sketch qui ne
renvoie jamais son état laisse l'état inchangé dans Gladys.

Allumer (ou une luminosité au-dessus de 0) est refusé, et rien n'est envoyé,
quand : la configuration n'est pas lue ou pas valide ; le couple n'est pas
déclaré sûr ; le nœud a présenté ce capteur comme un autre type depuis le
démarrage de l'intégration (une présentation entendue avant un redémarrage
n'est pas gardée : la déclaration reste la garde tant que le nœud ne s'est
pas présenté de nouveau) ; la
passerelle n'est pas connectée.

## Éteindre

Éteindre un relais ou une lumière (ou une luminosité de 0) n'est jamais
refusé pour une déclaration, une option ou une configuration pas encore lue,
et n'attend jamais le disque. L'arrêt est écrit tout de suite si la
passerelle est connectée, suivi d'une demande de version de la passerelle :
un envoi ne compte qu'une fois que la passerelle a répondu à cette demande,
ou à une suivante, sur la même connexion (chaque réponse va à la plus
ancienne demande encore en attente ; une réponse que personne n'a demandée,
ou une demande restée 10 s sans réponse, ne prouve rien ; pendant la minute
qui suit une réponse que personne n'a demandée, comme quand un autre
contrôleur parle à la même passerelle, seul l'écho du nœud compte) (elle a lu l'arrêt avant) ou que le nœud a renvoyé
l'arrêt en écho. Sinon Gladys se connecte aussitôt, et il part en premier ;
un clic pendant une tentative de connexion qui échoue relance un essai
aussitôt.

Sans écho du nœud, il est renvoyé après 1,5 s, 5 s, 20 s et 1 min. Après 5
envois lus par la passerelle sans aucun écho, il est signalé comme abandonné
dans le statut jusqu'à un nouveau clic. Une écriture sur une connexion fermée
avant la réponse de la passerelle (une passerelle qui redémarre, ou une
passerelle ESP8266 dont l'unique place client est prise) ne compte pas : un
tel arrêt n'est jamais abandonné, et repart à la connexion suivante.

Il est gardé sur le disque jusqu'à ce que le nœud le confirme (écho, ou état
éteint signalé après l'envoi), et renvoyé après un redémarrage, même avant la
lecture de la configuration (passerelle Ethernet, ou broker MQTT sans
identifiants). Il est levé sans être renvoyé quand une commande plus récente
de la même cible est réellement partie, ou quand le nœud, signalé éteint
avant le clic, se signale allumé deux fois après le départ de l'arrêt
(quelqu'un l'a rallumé sur place : un seul état a pu croiser l'arrêt, et la
paire marche/niveau d'un variateur compte pour un état) ; le statut le dit
alors jusqu'au prochain état signalé de la cible (10 minutes au plus).
Quand le nœud était allumé, ou son état inconnu, avant le clic, un état
allumé n'est pas un changement fait ailleurs : l'arrêt est renvoyé, puis
abandonné.

Il ne peut pas partir tant que la passerelle (ou le broker) est injoignable,
que le broker refuse les identifiants ou que la configuration n'est pas
valide : il est alors gardé et part en premier dès que la passerelle revient,
que de nouveaux identifiants sont enregistrés ou que le bouton de test
réussit. Le statut dit où il en est : gardé (pas encore lu par la
passerelle), envoyé et pas encore confirmé, abandonné, ou rallumé sur place.

## Ids des nœuds

Un nœud sans id fixe (`MY_NODE_ID AUTO`) en demande un au contrôleur. Avec
**Attribuer les ids des nœuds** activé (par défaut), Gladys donne le plus
petit id qu'aucun nœud n'utilise, et le garde sur le disque avant de le
donner. Un id donné et inutilisé pendant 5 minutes est redonné ; 10 ids
inutilisés au plus. Désactivez l'option si un autre contrôleur du même réseau
attribue les ids.

## Statut

L'écran de configuration montre l'état du lien (connecté, en attente de la
passerelle, injoignable avec le prochain essai), les arrêts non confirmés,
les entrées ignorées de la liste des relais sûrs, les messages ignorés (mal
formés, trop longs, ou au-delà de 200 par seconde), et si le disque de
l'intégration ne peut pas être lu ou écrit. En Ethernet, une passerelle
muette depuis plus de 150 s (vérifié chaque minute) est reconnectée ; après
un échec, les essais suivants attendent 1 s, puis jusqu'à 1 minute.

## Limites

- Une passerelle (un réseau MySensors) par intégration.
- Lignes de 256 octets et paquets MQTT de 4 Ko au plus ; 200 messages par
  seconde au plus.
- L'id du nœud est son identité (MySensors ne donne pas de numéro de série) :
  un nœud reprogrammé avec un autre sketch sous le même id reste le même
  appareil.
