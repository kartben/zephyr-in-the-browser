/**
 * "Run in simulator" widget for the mirrored Zephyr doc pages.
 *
 * tools/fetch-docs.mjs injects this file into every page together with a
 * window.ZEPHYR_SIM config object (app id, default board, path back to the
 * emulator). Deliberately framework-free: an eventual upstream version would
 * ship as a Sphinx extension, so nothing here may lean on the host app's
 * React/Tailwind stack — or on anything newer than <dialog>.
 */
;(function () {
  'use strict'

  var cfg = window.ZEPHYR_SIM
  if (!cfg) return

  var simUrl =
    cfg.simRoot + '?board=' + encodeURIComponent(cfg.board) + '&app=' + encodeURIComponent(cfg.app)

  var dialog = null
  var iframe = null

  function ensureDialog() {
    if (dialog) return
    dialog = document.createElement('dialog')
    dialog.className = 'zsim-dialog'
    dialog.innerHTML =
      '<div class="zsim-header">' +
      '<span class="zsim-dot"></span>' +
      '<span class="zsim-title"></span>' +
      '<span class="zsim-spacer"></span>' +
      '<a class="zsim-newtab" target="_blank" rel="noopener">Open in new tab &#8599;</a>' +
      '<button type="button" class="zsim-close" title="Close (Esc)">&#10005;</button>' +
      '</div>' +
      '<iframe class="zsim-frame" title="Zephyr in the Browser" ' +
      'allow="accelerometer; gyroscope; magnetometer; ambient-light-sensor; fullscreen"></iframe>'

    dialog.querySelector('.zsim-title').textContent =
      (cfg.title || 'Zephyr sample') + ' — running in your browser'
    dialog.querySelector('.zsim-newtab').href = simUrl
    dialog.querySelector('.zsim-close').addEventListener('click', function () {
      dialog.close()
    })
    // A click that lands on the <dialog> element itself can only be on the
    // backdrop (the header and iframe cover the whole content box).
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close()
    })
    // Unload the emulator on close — a hidden iframe would keep the wasm
    // vCPU spinning at full tilt behind the docs page.
    dialog.addEventListener('close', function () {
      iframe.src = 'about:blank'
    })

    iframe = dialog.querySelector('.zsim-frame')
    document.body.appendChild(dialog)
  }

  function openDialog() {
    ensureDialog()
    iframe.src = simUrl
    dialog.showModal()
  }

  function init() {
    var body = document.querySelector('[itemprop="articleBody"]') || document.body

    var btn = document.createElement('a')
    btn.href = simUrl
    btn.className = 'btn fa fa-play zsim-run'
    btn.appendChild(document.createTextNode(' Run in simulator'))
    btn.title = 'Boot this sample on an emulated board, right here in the browser'
    btn.addEventListener('click', function (e) {
      // A plain click opens the dialog; modified clicks (middle, ctrl/cmd…)
      // keep their browser meaning through the href.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      openDialog()
    })

    // The zephyr:code-sample directive renders "Browse source code on GitHub"
    // right under the H1 — the run button belongs beside it.
    var github = body.querySelector('a.btn[href*="github.com"]')
    if (github) {
      github.insertAdjacentElement('afterend', btn)
    } else {
      var h1 = body.querySelector('h1')
      if (h1) h1.insertAdjacentElement('afterend', btn)
    }

    // Provenance: these pages are point-in-time snapshots of the live docs.
    if (cfg.canonical) {
      var note = document.createElement('p')
      note.className = 'zsim-mirror-note'
      note.innerHTML =
        'Snapshot of the official Zephyr documentation, mirrored ' +
        cfg.mirrored +
        ' &mdash; <a href="' +
        cfg.canonical +
        '">view the live page</a>.'
      body.insertBefore(note, body.firstChild)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
