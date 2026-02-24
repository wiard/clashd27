/**
 * CLASHD27 — Frontpage JS
 * Fetches live data and populates the public frontpage.
 */
(function () {
  'use strict';

  // --- Helpers ---
  function esc(t) {
    if (!t) return '';
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function relTime(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    var now = Date.now();
    var diff = now - d.getTime();
    if (diff < 0) return 'just now';
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function shortDate(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function safeFetch(url, timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        clearTimeout(timer);
        return null;
      });
  }

  // --- Summary / Stats ---
  function loadSummary() {
    safeFetch('/api/public/summary').then(function (data) {
      if (!data) return;
      var el = function (id) { return document.getElementById(id); };
      el('s-total').textContent = data.totalGaps || 0;
      el('s-7d').textContent = data.gaps7d || 0;
      el('s-corridors').textContent = data.corridorsCount || 0;

      if (data.papers7d && data.papers7d > 0) {
        el('s-papers').textContent = data.papers7d;
      } else {
        var wrap = el('s-papers-wrap');
        if (wrap) wrap.style.display = 'none';
      }

      el('s-last').textContent = data.lastGapDate ? shortDate(data.lastGapDate) : '--';

      if (data.lastUpdated) {
        el('hero-updated').textContent = 'updated ' + relTime(data.lastUpdated);
      }
    });
  }

  // --- Featured Gap ---
  function loadFeatured() {
    safeFetch('/api/public/featured').then(function (data) {
      var container = document.getElementById('featured-gap');
      if (!data || !data.id) {
        container.innerHTML = '<div class="warming-up"><span class="spinner"></span> The cube is warming up. First gaps will appear soon.</div>';
        return;
      }

      var evidenceHtml = '';
      if (data.evidence && data.evidence.length > 0) {
        evidenceHtml = '<ul class="featured-evidence">' +
          data.evidence.slice(0, 3).map(function (e) {
            return '<li>' + esc(e) + '</li>';
          }).join('') + '</ul>';
      }

      var expHtml = '';
      if (data.proposed_experiment) {
        expHtml = '<div class="featured-experiment">' + esc(data.proposed_experiment) + '</div>';
      }

      container.innerHTML =
        '<div class="featured-card">' +
        '<div class="featured-corridor">' +
        esc(data.corridor) +
        ' <span class="score-badge">SCORE ' + (data.score || 0) + '</span>' +
        '</div>' +
        '<div class="featured-claim">' + esc(data.claim) + '</div>' +
        evidenceHtml +
        expHtml +
        '<div class="featured-actions">' +
        '<a href="/gaps/' + encodeURIComponent(data.id) + '" class="btn btn-primary" style="font-size:11px;padding:10px 20px">OPEN GAP</a>' +
        '</div>' +
        '</div>';
    });
  }

  // --- Activity Feed ---
  var feedOffset = 0;
  var feedLimit = 10;

  function loadFeed(append) {
    var limit = append ? 10 : feedLimit;
    var url = '/api/public/latest?limit=' + (feedOffset + limit);
    safeFetch(url).then(function (data) {
      var container = document.getElementById('feed-list');
      if (!data || !Array.isArray(data) || data.length === 0) {
        if (!append) {
          container.innerHTML = '<div class="warming-up"><span class="spinner"></span> Waiting for first gaps...</div>';
        }
        document.getElementById('load-more-row').style.display = 'none';
        return;
      }

      var items = append ? data.slice(feedOffset) : data;
      feedOffset = data.length;

      var html = items.map(function (g) {
        return '<a href="/gaps/' + encodeURIComponent(g.id) + '" class="feed-item">' +
          '<span class="feed-time">' + (g.date ? shortDate(g.date) : '--') + '</span>' +
          '<span class="feed-claim">' + esc(g.claim) + '</span>' +
          '<span class="feed-corridor">' + esc(g.corridor) + '</span>' +
          '</a>';
      }).join('');

      if (append) {
        container.insertAdjacentHTML('beforeend', html);
      } else {
        container.innerHTML = html;
      }

      document.getElementById('load-more-row').style.display = items.length >= 10 ? 'block' : 'none';
    });
  }

  // --- Leaderboard Teaser ---
  function loadLeaderboard() {
    safeFetch('/api/public/leaderboard?limit=5').then(function (data) {
      var container = document.getElementById('leaderboard-teaser');
      if (!data || !Array.isArray(data) || data.length === 0) {
        container.innerHTML = '<div class="warming-up"><span class="spinner"></span> No repository data yet. Gaps need linked repos to populate the leaderboard.</div>';
        return;
      }

      var rows = data.map(function (r) {
        var badges = '';
        if (r.open > 0) badges += '<span class="lb-badge lb-badge-open">' + r.open + ' open</span>';
        if (r.responded > 0) badges += '<span class="lb-badge lb-badge-responded">' + r.responded + ' resp</span>';
        if (r.resolved > 0) badges += '<span class="lb-badge lb-badge-resolved">' + r.resolved + ' done</span>';
        return '<tr>' +
          '<td class="lb-repo">' + esc(r.repo) + '</td>' +
          '<td>' + r.gapCount + '</td>' +
          '<td>' + badges + '</td>' +
          '</tr>';
      }).join('');

      container.innerHTML =
        '<table class="lb-table">' +
        '<thead><tr><th>Repository</th><th>Gaps</th><th>Status</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div style="margin-top:12px"><a href="/leaderboard" class="btn btn-secondary" style="font-size:11px;padding:8px 20px">VIEW FULL LEADERBOARD</a></div>';
    });
  }

  // --- Subscribe ---
  function initSubscribe() {
    var btn = document.getElementById('subscribe-btn');
    var input = document.getElementById('subscribe-email');
    var msg = document.getElementById('subscribe-msg');
    if (!btn) return;

    function doSubscribe() {
      var email = (input.value || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = 'Please enter a valid email.';
        msg.style.color = 'var(--orange)';
        return;
      }
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/api/public/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            msg.textContent = 'Subscribed! You\'ll get weekly gap digests.';
            msg.style.color = 'var(--green)';
            input.value = '';
          } else {
            msg.textContent = data.error || 'Something went wrong.';
            msg.style.color = 'var(--orange)';
          }
        })
        .catch(function () {
          msg.textContent = 'Network error. Try again later.';
          msg.style.color = 'var(--orange)';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'WEEKLY DIGEST';
        });
    }

    btn.addEventListener('click', doSubscribe);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSubscribe();
    });
  }

  // --- Init ---
  function init() {
    loadSummary();
    loadFeatured();
    loadFeed(false);
    loadLeaderboard();
    initSubscribe();

    var loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function () {
        loadFeed(true);
      });
    }

    // Auto-refresh stats every 60s
    setInterval(loadSummary, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
