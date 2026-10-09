---
tour: "Blinky : faites le tour de la page"
sample: samples/basic/blinky
source: no
next: basic_button
---

Blinky fait clignoter une LED une fois par seconde, indéfiniment. Ces arrêts
vous font faire le tour de la page pendant qu'il s'exécute : le **terminal**,
le **dock des périphériques**, **Debug** et l'endroit où choisir un autre
exemple.

## Le terminal est la console de l'invité

```tour
at: main.c:/gpio_pin_configure_dt/
when: first
stop: no
```

Vous êtes dans le **Simulateur** : Zephyr tourne sur une carte émulée,
directement dans votre navigateur. Le **terminal** est la console série du
système invité. Les messages de démarrage et la sortie de l'exemple y
apparaissent.

La carte et l'application choisies dans la barre du haut décident de ce qui
tourne.

## Regardez la LED dans le dock des périphériques

```tour
at: main.c:/gpio_pin_toggle_dt/
when: first
panel: led
```

L'invité est en pause juste avant que Blinky ne fasse basculer sa LED.

Le **dock des périphériques** recense le matériel de cette carte, et la LED y
a sa propre ligne. Appuyez sur **Continuer** et regardez-la changer.

## Debug montre où en est l'invité

```tour
at: main.c:/k_msleep/
when: first
look: debug.threads
```

Chaque arrêt d'une visite est un point d'arrêt. **Debug**, sous Instruments
dans le dock des périphériques, montre où l'invité est en pause : la pile
d'appels, les registres du CPU, la mémoire et les threads.

Le code de Blinky tourne dans un seul thread, `main`. Il s'apprête à dormir
pendant une seconde, et `idle` tourne en attendant.

## Parcourez les exemples quand vous le souhaitez

```tour
at: main.c:/gpio_pin_toggle_dt/
when: first
stop: no
```

Pour essayer un autre exemple, ouvrez le sélecteur d'application de la barre
du haut (il affiche **Blinky** pour l'instant). Ceux qui ont une visite comme
celle-ci sont listés en premier, sous **Visites guidées**.

## Ce que vous avez vu

Voilà pour la page : le terminal pour la sortie, le dock des périphériques pour
le matériel et Debug pour l'état de l'invité. Blinky continue de clignoter.

Blinky a une deuxième visite, **Blinky, explained** (en anglais pour
l'instant), listée sous Blinky dans le sélecteur d'application. Elle suit la
broche de la LED depuis le devicetree jusqu'au pilote GPIO.

Ou passez à l'exemple Button, qui lit un bouton que vous pressez dans le dock
des périphériques.
