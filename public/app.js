/* ============================================================
   GainMetric — Application Logic
   SPA Router, Auth, Dashboard, Strength Tracker, Macro Tracker
   ============================================================ */

(() => {
  'use strict';

  // ——— Helpers ———
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
  const today = () => new Date().toISOString().slice(0, 10);
  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ——— Storage ———
  const store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem('gm_' + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) { localStorage.setItem('gm_' + key, JSON.stringify(val)); },
    remove(key) { localStorage.removeItem('gm_' + key); }
  };

  // ——— Auth ———
  let currentUser = store.get('currentUser', null);
  let authToken = store.get('authToken', null);
  let currentAuthMode = 'signup';
  let trialInfo = null;

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideAuthError() {
    const el = $('#auth-error');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function showAuthModal(mode = 'signup') {
    currentAuthMode = mode;
    const modal = $('#auth-modal');
    const title = $('#auth-title');
    const nameGroup = $('#auth-name-group');
    const submit = $('#auth-submit');
    const toggle = $('#auth-toggle-text');

    hideAuthError();
    modal.classList.remove('hidden');

    // Reset Turnstile widget
    if (window.turnstile) {
      const widgetEl = $('#turnstile-widget');
      if (widgetEl) turnstile.reset();
    }

    if (mode === 'signup') {
      title.textContent = 'Create Account';
      nameGroup.classList.remove('hidden');
      submit.textContent = 'Create Account';
      toggle.innerHTML = 'Already have an account? <a id="auth-switch" href="#">Sign In</a>';
    } else {
      title.textContent = 'Welcome Back';
      nameGroup.classList.add('hidden');
      submit.textContent = 'Sign In';
      toggle.innerHTML = 'New here? <a id="auth-switch" href="#">Create Account</a>';
    }
    $('#auth-switch').onclick = (e) => { e.preventDefault(); showAuthModal(mode === 'signup' ? 'signin' : 'signup'); };
  }

  async function handleAuth(e) {
    e.preventDefault();
    hideAuthError();

    const name = $('#auth-name').value.trim() || 'Lifter';
    const email = $('#auth-email').value.trim();
    const password = $('#auth-pass').value;

    if (!email || !password) {
      showAuthError('Please fill in all fields');
      return;
    }
    if (currentAuthMode === 'signup' && password.length < 6) {
      showAuthError('Password must be at least 6 characters');
      return;
    }

    // Get Turnstile token
    let turnstileToken = '';
    if (window.turnstile) {
      turnstileToken = turnstile.getResponse();
      if (!turnstileToken) {
        showAuthError('Please complete the verification');
        return;
      }
    }

    const submit = $('#auth-submit');
    const originalText = submit.textContent;
    submit.textContent = 'Please wait...';
    submit.disabled = true;

    try {
      const endpoint = currentAuthMode === 'signup' ? '/api/auth/signup' : '/api/auth/signin';
      const body = { email, password, turnstileToken };
      if (currentAuthMode === 'signup') body.name = name;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();

      if (!res.ok) {
        showAuthError(data.error || 'Something went wrong');
        if (window.turnstile) turnstile.reset();
        return;
      }

      // Success — store token and user
      authToken = data.token;
      currentUser = data.user;
      trialInfo = data.trial;
      store.set('authToken', authToken);
      store.set('currentUser', currentUser);

      $('#auth-modal').classList.add('hidden');
      $('#auth-form').reset();

      // Check trial
      if (trialInfo && trialInfo.trialExpired) {
        showPaywall();
        return;
      }

      updateTrialBanner();

      if (!store.get('onboardingComplete', false)) {
        $('#onboarding-modal').classList.remove('hidden');
        $('#onboarding-step-1').classList.remove('hidden');
        $('#onboarding-step-2').classList.add('hidden');
      } else {
        navigate('dashboard');
        toast('Welcome, ' + currentUser.name + '!');
      }
    } catch (err) {
      console.error('Auth error:', err);
      showAuthError('Network error. Please try again.');
    } finally {
      submit.textContent = originalText;
      submit.disabled = false;
    }
  }

  function showPaywall(isVoluntaryUpgrade = false) {
    const modal = $('#paywall-modal');
    modal.classList.remove('hidden');
    if (!isVoluntaryUpgrade) {
      modal.dataset.locked = 'true';
      $('.paywall-title').textContent = 'Trial Ended';
      $('.paywall-sub').textContent = 'Your 10-day free trial has expired. Upgrade to keep tracking your gains.';
    } else {
      modal.dataset.locked = 'false';
      $('.paywall-title').textContent = 'Upgrade to Premium ✨';
      $('.paywall-sub').textContent = 'Subscribe to Premium and track your gains!';
    }
  }

  function updateTrialBanner() {
    const banner = $('#trial-banner');
    if (!banner) return;
    if (trialInfo && !trialInfo.isPaid && trialInfo.trialActive) {
      banner.classList.remove('hidden');
      $('#trial-days-left').textContent = trialInfo.daysRemaining;
    } else {
      banner.classList.add('hidden');
    }
  }

  async function checkAuthStatus() {
    if (!authToken) return false;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      if (!res.ok) {
        // Token expired or invalid
        authToken = null;
        currentUser = null;
        store.remove('authToken');
        store.remove('currentUser');
        return false;
      }
      const data = await res.json();
      currentUser = data.user;
      trialInfo = data.trial;
      store.set('currentUser', currentUser);
      return true;
    } catch {
      return false;
    }
  }

  // ——— Onboarding & TDEE ———
  function calculateTDEE(e) {
    e.preventDefault();
    const sex = $('#ob-sex').value;
    const age = parseInt($('#ob-age').value);
    const height = parseInt($('#ob-height').value);
    const weight = parseInt($('#ob-weight').value);
    const activity = parseFloat($('#ob-activity').value);
    const goal = $('#ob-goal').value;

    let bmr = (10 * weight) + (6.25 * height) - (5 * age) + (sex === 'M' ? 5 : -161);
    let tdee = bmr * activity;

    let targetCalories = tdee;
    let protein = weight * 2.2; // ~2.2g per kg of bodyweight
    let fats;

    if (goal === 'cut') {
      targetCalories -= 500;
      fats = (targetCalories * 0.25) / 9;
    } else if (goal === 'bulk') {
      targetCalories += 500;
      fats = (targetCalories * 0.30) / 9;
    } else {
      fats = (targetCalories * 0.25) / 9;
    }

    const remCals = targetCalories - (protein * 4) - (fats * 9);
    let carbs = remCals > 0 ? remCals / 4 : 0;

    const targets = {
      calories: Math.round(targetCalories),
      protein: Math.round(protein),
      fats: Math.round(fats),
      carbs: Math.round(carbs)
    };
    store.set('macroTargets', targets);
    store.set('onboardingComplete', true);

    $('#ob-res-cals').textContent = targets.calories;
    $('#ob-res-p').textContent = targets.protein + 'g';
    $('#ob-res-c').textContent = targets.carbs + 'g';
    $('#ob-res-f').textContent = targets.fats + 'g';

    $('#onboarding-step-1').classList.add('hidden');
    $('#onboarding-step-2').classList.remove('hidden');
  }

  function finishOnboarding() {
    $('#onboarding-modal').classList.add('hidden');
    navigate('dashboard');
    toast('Welcome, ' + currentUser.name + '!');
  }

  function logout() {
    currentUser = null;
    authToken = null;
    trialInfo = null;
    store.remove('currentUser');
    store.remove('authToken');
    navigate('landing');
    toast('Logged out');
  }

  // ——— Router ———
  const pages = ['landing', 'dashboard', 'strength', 'macros'];

  function navigate(page) {
    if (!page || !pages.includes(page)) page = 'landing';
    if (page !== 'landing' && !currentUser) { page = 'landing'; }

    pages.forEach(p => {
      const el = $(`#page-${p}`);
      if (el) el.classList.toggle('hidden', p !== page);
    });

    const nav = $('#main-nav');
    nav.classList.toggle('hidden', page === 'landing');

    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
    $$('.bottom-nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));

    window.location.hash = page === 'landing' ? '' : page;

    if (page === 'dashboard') renderDashboard();
    if (page === 'strength') renderStrength();
    if (page === 'macros') renderMacros();
  }

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1) || 'landing';
    navigate(hash);
  });

  // ——— DASHBOARD ———
  let weightChart = null;

  function renderDashboard() {
    if (!currentUser) return;
    $('#dash-username').textContent = currentUser.name.split(' ')[0];
    $('#dash-date').textContent = formatDate(today());

    // Daily macros
    const macroLog = store.get('foodLog_' + today(), []);
    const totals = macroLog.reduce((acc, f) => {
      acc.calories += f.calories; acc.protein += f.protein; acc.carbs += f.carbs; acc.fats += f.fats;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fats: 0 });
    const targets = store.get('macroTargets', { protein: 180, carbs: 250, fats: 70, calories: 2400 });

    $('#dash-calories').textContent = Math.round(totals.calories);
    const calPct = Math.min(100, (totals.calories / targets.calories) * 100);
    $('#dash-cal-bar').style.width = calPct + '%';

    $('#dash-protein').textContent = Math.round(totals.protein) + 'g';
    const proPct = Math.min(100, (totals.protein / targets.protein) * 100);
    $('#dash-pro-bar').style.width = proPct + '%';

    // Workouts this week
    const weekStart = getWeekStart();
    const allWorkouts = store.get('workouts', []);
    const weekWorkouts = allWorkouts.filter(w => w.date >= weekStart);
    const uniqueDays = new Set(weekWorkouts.map(w => w.date)).size;
    $('#dash-workouts').textContent = uniqueDays;
    $('#dash-workout-detail').textContent = uniqueDays >= 5 ? 'Beast mode! 💪' : uniqueDays >= 3 ? 'Solid week!' : 'Keep pushing!';

    // Current weight
    const weights = store.get('weights', []);
    if (weights.length) {
      const last = weights[weights.length - 1];
      $('#dash-weight').textContent = last.value + ' kg';
      if (weights.length > 1) {
        const diff = (last.value - weights[weights.length - 2].value).toFixed(1);
        const sign = diff > 0 ? '+' : '';
        $('#dash-weight-detail').textContent = sign + diff + ' kg from last entry';
      }
    } else {
      $('#dash-weight').textContent = '—';
      $('#dash-weight-detail').textContent = 'Log your first weigh-in!';
    }

    // Weight chart
    renderWeightChart(weights);
  }

  function getWeekStart() {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toISOString().slice(0, 10);
  }

  function renderWeightChart(weights) {
    const ctx = $('#weight-chart');
    if (!ctx) return;

    const labels = weights.map(w => {
      const d = new Date(w.date);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const data = weights.map(w => w.value);

    if (weightChart) weightChart.destroy();

    if (!data.length) {
      data.push(0);
      labels.push('No data');
    }

    weightChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Weight (kg)',
          data,
          borderColor: '#39ff14',
          backgroundColor: 'rgba(57,255,20,0.08)',
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#39ff14',
          pointBorderColor: '#0a0a0a',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111111', titleColor: '#39ff14', bodyColor: '#f0f0f0',
            borderColor: '#1e1e1e', borderWidth: 1, cornerRadius: 8,
            padding: 12,
          }
        },
        scales: {
          x: { ticks: { color: '#555', font: { size: 11 } }, grid: { color: '#1e1e1e' } },
          y: { ticks: { color: '#555', font: { size: 11 } }, grid: { color: '#1e1e1e' },
            beginAtZero: false,
          }
        },
        interaction: { intersect: false, mode: 'index' },
      }
    });
  }

  function logWeight() {
    const input = $('#weight-input');
    const val = parseFloat(input.value);
    if (!val || val <= 0) return toast('Enter a valid weight');
    const weights = store.get('weights', []);
    // Replace if today already logged
    const existing = weights.findIndex(w => w.date === today());
    if (existing >= 0) weights[existing].value = val;
    else weights.push({ date: today(), value: val });
    store.set('weights', weights);
    input.value = '';
    renderDashboard();
    toast('Weight logged: ' + val + ' kg');
  }

  // ——— STRENGTH TRACKER ———
  function renderStrength() {
    resetSets();
    populateHistoryFilter();
    renderWorkoutHistory();
  }

  function resetSets() {
    const container = $('#sets-container');
    container.innerHTML = `
      <div class="set-row">
        <span class="set-label">Set 1</span>
        <input type="number" placeholder="Reps" class="input-sm set-reps" min="1" />
        <input type="number" placeholder="Weight (kg)" class="input-sm set-weight" min="0" step="2.5" />
      </div>`;
  }

  function addSet() {
    const container = $('#sets-container');
    const count = $$('.set-row', container).length + 1;
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <span class="set-label">Set ${count}</span>
      <input type="number" placeholder="Reps" class="input-sm set-reps" min="1" />
      <input type="number" placeholder="Weight (kg)" class="input-sm set-weight" min="0" step="2.5" />`;
    container.appendChild(row);
  }

  function removeSet() {
    const rows = $$('.set-row', $('#sets-container'));
    if (rows.length > 1) rows[rows.length - 1].remove();
  }

  function logExercise() {
    const exercise = $('#exercise-select').value;
    const rows = $$('.set-row', $('#sets-container'));
    const sets = [];
    rows.forEach(row => {
      const reps = parseInt($('.set-reps', row).value);
      const weight = parseFloat($('.set-weight', row).value);
      if (reps > 0 && weight >= 0) sets.push({ reps, weight });
    });
    if (!sets.length) return toast('Fill in at least one set');

    const workouts = store.get('workouts', []);
    workouts.unshift({ exercise, sets, date: today(), time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
    store.set('workouts', workouts);
    resetSets();
    populateHistoryFilter();
    renderWorkoutHistory();
    toast(exercise + ' logged — ' + sets.length + ' sets');
  }

  function populateHistoryFilter() {
    const workouts = store.get('workouts', []);
    const exercises = [...new Set(workouts.map(w => w.exercise))];
    const select = $('#history-filter');
    select.innerHTML = '<option value="all">All Exercises</option>';
    exercises.forEach(ex => {
      const opt = document.createElement('option');
      opt.value = ex; opt.textContent = ex;
      select.appendChild(opt);
    });
  }

  function renderWorkoutHistory() {
    const workouts = store.get('workouts', []);
    const filter = $('#history-filter').value;
    const filtered = filter === 'all' ? workouts : workouts.filter(w => w.exercise === filter);
    const container = $('#workout-history');

    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">No workouts logged yet. Crush your first session!</p>';
      return;
    }

    container.innerHTML = filtered.slice(0, 30).map((w, i) => `
      <div class="history-item">
        <div class="history-item-header">
          <h4>${w.exercise}</h4>
          <small>${w.date} ${w.time || ''}</small>
        </div>
        <div class="history-sets">
          ${w.sets.map((s, j) => `<span class="history-set-badge">${s.reps}×${s.weight}kg</span>`).join('')}
        </div>
      </div>`).join('');
  }

  // ——— MACRO TRACKER ———
    const FOOD_DB = [
    { name: 'Curry', calories: 130, protein: 3, carbs: 12, fats: 8 },
    { name: 'Sabzi', calories: 130, protein: 3, carbs: 12, fats: 8 },
    { name: 'Gravy', calories: 130, protein: 3, carbs: 12, fats: 8 },
    { name: 'Korma', calories: 130, protein: 3, carbs: 12, fats: 8 },
    { name: 'Kofta', calories: 130, protein: 3, carbs: 12, fats: 8 },
    { name: 'Dal', calories: 115, protein: 6, carbs: 17, fats: 3 },
    { name: 'Sambar', calories: 115, protein: 6, carbs: 17, fats: 3 },
    { name: 'Rasam', calories: 115, protein: 6, carbs: 17, fats: 3 },
    { name: 'Soup', calories: 115, protein: 6, carbs: 17, fats: 3 },
    { name: 'Biryani', calories: 160, protein: 5, carbs: 25, fats: 5 },
    { name: 'Pulao', calories: 160, protein: 5, carbs: 25, fats: 5 },
    { name: 'Rice', calories: 160, protein: 5, carbs: 25, fats: 5 },
    { name: 'Khichdi', calories: 160, protein: 5, carbs: 25, fats: 5 },
    { name: 'Roti', calories: 270, protein: 8, carbs: 48, fats: 6 },
    { name: 'Naan', calories: 270, protein: 8, carbs: 48, fats: 6 },
    { name: 'Bread', calories: 270, protein: 8, carbs: 48, fats: 6 },
    { name: 'Khakhra', calories: 270, protein: 8, carbs: 48, fats: 6 },
    { name: 'Thepla', calories: 270, protein: 8, carbs: 48, fats: 6 },
    { name: 'Dosa', calories: 140, protein: 4, carbs: 24, fats: 3 },
    { name: 'Idli', calories: 140, protein: 4, carbs: 24, fats: 3 },
    { name: 'Uttapam', calories: 140, protein: 4, carbs: 24, fats: 3 },
    { name: 'Cheela', calories: 140, protein: 4, carbs: 24, fats: 3 },
    { name: 'Handvo', calories: 140, protein: 4, carbs: 24, fats: 3 },
    { name: 'Pakora', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Bhaji', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Vada', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Kachori', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Bonda', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Fry', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Snack', calories: 320, protein: 6, carbs: 35, fats: 18 },
    { name: 'Tikka (Meat/Paneer)', calories: 180, protein: 14, carbs: 6, fats: 11 },
    { name: 'Tandoori (Meat/Paneer)', calories: 180, protein: 14, carbs: 6, fats: 11 },
    { name: 'Kebab (Meat/Paneer)', calories: 180, protein: 14, carbs: 6, fats: 11 },
    { name: 'Chutney', calories: 150, protein: 1, carbs: 15, fats: 10 },
    { name: 'Pickle (Achar)', calories: 150, protein: 1, carbs: 15, fats: 10 },
    { name: 'Halwa', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Ladoo', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Barfi', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Peda', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Mithai', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Chikki', calories: 420, protein: 6, carbs: 60, fats: 18 },
    { name: 'Kheer', calories: 110, protein: 3, carbs: 18, fats: 3 },
    { name: 'Payasam', calories: 110, protein: 3, carbs: 18, fats: 3 },
    { name: 'Poha', calories: 250, protein: 5, carbs: 38, fats: 9 },
    { name: 'Upma', calories: 250, protein: 5, carbs: 38, fats: 9 },
    { name: 'Chivda', calories: 250, protein: 5, carbs: 38, fats: 9 },
    { name: 'Sev', calories: 250, protein: 5, carbs: 38, fats: 9 },
    { name: 'Chaat', calories: 150, protein: 4, carbs: 22, fats: 5 },
    { name: 'Puri', calories: 300, protein: 5, carbs: 38, fats: 14 },
    { name: 'Bhatura', calories: 300, protein: 5, carbs: 38, fats: 14 },
    { name: 'Jalebi', calories: 300, protein: 3, carbs: 55, fats: 7 },
    { name: 'Imarti', calories: 300, protein: 3, carbs: 55, fats: 7 },
    { name: 'Rasgulla', calories: 300, protein: 3, carbs: 55, fats: 7 },
    { name: 'Sandesh', calories: 300, protein: 3, carbs: 55, fats: 7 },
    { name: 'Dhokla', calories: 160, protein: 5, carbs: 22, fats: 6 },
    { name: 'Paneer Butter Masala', calories: 250, protein: 8, carbs: 12, fats: 19 },
    { name: 'Shahi Paneer', calories: 250, protein: 8, carbs: 12, fats: 19 },
    { name: 'Malai Kofta', calories: 250, protein: 8, carbs: 12, fats: 19 },
    { name: 'Palak Paneer', calories: 180, protein: 9, carbs: 10, fats: 12 },
    { name: 'Matar Paneer', calories: 180, protein: 9, carbs: 10, fats: 12 },
    { name: 'Paneer Tikka Masala', calories: 220, protein: 11, carbs: 9, fats: 15 },
    { name: 'Paneer Bhurji', calories: 220, protein: 11, carbs: 9, fats: 15 },
    { name: 'Chicken Curry', calories: 160, protein: 15, carbs: 7, fats: 8 },
    { name: 'Egg Curry', calories: 160, protein: 15, carbs: 7, fats: 8 },
    { name: 'Fish Curry', calories: 160, protein: 15, carbs: 7, fats: 8 },
    { name: 'Machher Jhol', calories: 160, protein: 15, carbs: 7, fats: 8 },
    { name: 'Butter Chicken', calories: 230, protein: 14, carbs: 8, fats: 16 },
    { name: 'Chicken Tikka Masala', calories: 230, protein: 14, carbs: 8, fats: 16 },
    { name: 'Chingri Malai', calories: 230, protein: 14, carbs: 8, fats: 16 },
    { name: 'Tandoori Chicken', calories: 150, protein: 20, carbs: 4, fats: 6 },
    { name: 'Chicken Tikka', calories: 150, protein: 20, carbs: 4, fats: 6 },
    { name: 'Mutton Biryani', calories: 190, protein: 10, carbs: 22, fats: 7 },
    { name: 'Chicken Biryani', calories: 190, protein: 10, carbs: 22, fats: 7 },
    { name: 'Vegetable Biryani', calories: 150, protein: 4, carbs: 25, fats: 4 },
    { name: 'Goan Fish Curry', calories: 170, protein: 14, carbs: 8, fats: 10 },
    { name: 'Fish Molee', calories: 170, protein: 14, carbs: 8, fats: 10 },
    { name: 'Prawn Masala', calories: 170, protein: 14, carbs: 8, fats: 10 },
    { name: 'Keema Curry', calories: 210, protein: 16, carbs: 10, fats: 12 },
    { name: 'Nihari', calories: 210, protein: 16, carbs: 10, fats: 12 },
    { name: 'Haleem', calories: 210, protein: 16, carbs: 10, fats: 12 },
    { name: 'Dal Tadka', calories: 130, protein: 7, carbs: 18, fats: 5 },
    { name: 'Dal Makhani', calories: 130, protein: 7, carbs: 18, fats: 5 },
    { name: 'Cholar Dal', calories: 130, protein: 7, carbs: 18, fats: 5 },
    { name: 'Dalma', calories: 130, protein: 7, carbs: 18, fats: 5 },
    { name: 'Chana Masala', calories: 140, protein: 6, carbs: 20, fats: 5 },
    { name: 'Rajma Masala', calories: 140, protein: 6, carbs: 20, fats: 5 },
    { name: 'Kadhi Pakora', calories: 160, protein: 5, carbs: 14, fats: 10 },
    { name: 'Baingan Bharta', calories: 110, protein: 3, carbs: 12, fats: 6 },
    { name: 'Aloo Gobi', calories: 110, protein: 3, carbs: 12, fats: 6 },
    { name: 'Bhindi Masala', calories: 110, protein: 3, carbs: 12, fats: 6 },
    { name: 'Undhiyu', calories: 110, protein: 3, carbs: 12, fats: 6 },
    { name: 'Lauki Kofta', calories: 140, protein: 3, carbs: 14, fats: 9 },
    { name: 'Navratan Korma', calories: 140, protein: 3, carbs: 14, fats: 9 },
    { name: 'Veg Jalfrezi', calories: 140, protein: 3, carbs: 14, fats: 9 },
    { name: 'Avial', calories: 140, protein: 3, carbs: 14, fats: 9 },
    { name: 'Aloo Posto', calories: 120, protein: 2, carbs: 15, fats: 6 },
    { name: 'Shukto', calories: 120, protein: 2, carbs: 15, fats: 6 },
    { name: 'Olan', calories: 120, protein: 2, carbs: 15, fats: 6 },
    { name: 'Thoran', calories: 120, protein: 2, carbs: 15, fats: 6 },
    { name: 'Erissery', calories: 120, protein: 2, carbs: 15, fats: 6 },
    { name: 'Pav Bhaji', calories: 180, protein: 5, carbs: 25, fats: 7 },
    { name: 'Misal Pav', calories: 180, protein: 5, carbs: 25, fats: 7 },
    { name: 'Ragda Pattice', calories: 180, protein: 5, carbs: 25, fats: 7 },
    { name: 'Vada Pav', calories: 280, protein: 5, carbs: 32, fats: 15 },
    { name: 'Samosa', calories: 280, protein: 5, carbs: 32, fats: 15 },
    { name: 'Kachori', calories: 280, protein: 5, carbs: 32, fats: 15 },
    { name: 'Pani Puri', calories: 160, protein: 4, carbs: 26, fats: 5 },
    { name: 'Dahi Puri', calories: 160, protein: 4, carbs: 26, fats: 5 },
    { name: 'Bhel Puri', calories: 160, protein: 4, carbs: 26, fats: 5 },
    { name: 'Sev Puri', calories: 160, protein: 4, carbs: 26, fats: 5 },
    { name: 'Khandvi', calories: 150, protein: 6, carbs: 20, fats: 5 },
    { name: 'Patra', calories: 150, protein: 6, carbs: 20, fats: 5 },
    { name: 'Masala Dosa', calories: 160, protein: 4, carbs: 25, fats: 5 },
    { name: 'Rava Dosa', calories: 160, protein: 4, carbs: 25, fats: 5 },
    { name: 'Onion Uttapam', calories: 160, protein: 4, carbs: 25, fats: 5 },
    { name: 'Medu Vada', calories: 250, protein: 7, carbs: 28, fats: 12 },
    { name: 'Pesarattu', calories: 250, protein: 7, carbs: 28, fats: 12 },
    { name: 'Curd Rice', calories: 140, protein: 3, carbs: 24, fats: 4 },
    { name: 'Tamarind Rice', calories: 140, protein: 3, carbs: 24, fats: 4 },
    { name: 'Lemon Rice', calories: 140, protein: 3, carbs: 24, fats: 4 },
    { name: 'Puliyodarai', calories: 140, protein: 3, carbs: 24, fats: 4 },
    { name: 'Bisibele Bath', calories: 130, protein: 4, carbs: 22, fats: 3 },
    { name: 'Khichuri', calories: 130, protein: 4, carbs: 22, fats: 3 },
    { name: 'Pakhala Bhata', calories: 130, protein: 4, carbs: 22, fats: 3 },
    { name: 'Appam', calories: 160, protein: 3, carbs: 34, fats: 1 },
    { name: 'Puttu', calories: 160, protein: 3, carbs: 34, fats: 1 },
    { name: 'Idiyappam', calories: 160, protein: 3, carbs: 34, fats: 1 },
    { name: 'Momos', calories: 150, protein: 6, carbs: 24, fats: 3 },
    { name: 'Thukpa (Indian style)', calories: 150, protein: 6, carbs: 24, fats: 3 },
    { name: 'Seekh', calories: 220, protein: 15, carbs: 8, fats: 14 },
    { name: 'Shami', calories: 220, protein: 15, carbs: 8, fats: 14 },
    { name: 'Galouti', calories: 220, protein: 15, carbs: 8, fats: 14 },
    { name: 'Chapli Kebab', calories: 220, protein: 15, carbs: 8, fats: 14 },
    { name: 'Sandesh', calories: 190, protein: 5, carbs: 40, fats: 2 },
    { name: 'Rasgulla', calories: 190, protein: 5, carbs: 40, fats: 2 },
    { name: 'Cham Cham', calories: 190, protein: 5, carbs: 40, fats: 2 },
    { name: 'Mishti Doi', calories: 140, protein: 4, carbs: 20, fats: 5 },
    { name: 'Sheer Khurma', calories: 140, protein: 4, carbs: 20, fats: 5 },
    { name: 'Phirni', calories: 140, protein: 4, carbs: 20, fats: 5 },
    { name: 'Gajar ka Halwa', calories: 320, protein: 4, carbs: 45, fats: 14 },
    { name: 'Suji Halwa', calories: 320, protein: 4, carbs: 45, fats: 14 },
    { name: 'Badam Halwa', calories: 320, protein: 4, carbs: 45, fats: 14 },
    { name: 'Besan', calories: 400, protein: 5, carbs: 60, fats: 16 },
    { name: 'Motichoor', calories: 400, protein: 5, carbs: 60, fats: 16 },
    { name: 'Boondi Ladoo', calories: 400, protein: 5, carbs: 60, fats: 16 },
    { name: 'Kaju Katli', calories: 450, protein: 8, carbs: 52, fats: 24 },
    { name: 'Coconut Barfi', calories: 450, protein: 8, carbs: 52, fats: 24 },
    { name: 'Milk Peda', calories: 450, protein: 8, carbs: 52, fats: 24 },
    { name: 'Malpua', calories: 380, protein: 4, carbs: 55, fats: 18 },
    { name: 'Balushahi', calories: 380, protein: 4, carbs: 55, fats: 18 },
    { name: 'Ghevar', calories: 380, protein: 4, carbs: 55, fats: 18 },
    { name: 'Double ka Meetha', calories: 380, protein: 4, carbs: 55, fats: 18 },
    { name: 'Qubani ka Meetha', calories: 380, protein: 4, carbs: 55, fats: 18 },
    { name: 'Chhena Poda', calories: 280, protein: 10, carbs: 30, fats: 14 },
    { name: 'Aloo (Potato)', calories: 260, protein: 6, carbs: 42, fats: 8 },
    { name: 'Mixed Veg', calories: 260, protein: 6, carbs: 42, fats: 8 },
    { name: 'Gobi (Cauliflower)', calories: 260, protein: 6, carbs: 42, fats: 8 },
    { name: 'Paneer', calories: 310, protein: 10, carbs: 38, fats: 14 },
    { name: 'Cheese', calories: 310, protein: 10, carbs: 38, fats: 14 },
    { name: 'Onion', calories: 250, protein: 7, carbs: 44, fats: 7 },
    { name: 'Methi (Fenugreek)', calories: 250, protein: 7, carbs: 44, fats: 7 },
    { name: 'Chili', calories: 250, protein: 7, carbs: 44, fats: 7 },
    { name: 'Dal (Lentil)', calories: 270, protein: 9, carbs: 45, fats: 6 },
    { name: 'Keema (Minced Meat)', calories: 320, protein: 14, carbs: 36, fats: 13 },
    { name: 'Egg (Large)', calories: 72, protein: 6, carbs: 0, fats: 5 }
  ];


  let selectedFood = null;

  // Merge built-in + custom foods into one searchable list
  function getFullFoodDB() {
    const custom = store.get('customFoods', []);
    return [...FOOD_DB, ...custom];
  }

  function renderMacros() {
    const targets = store.get('macroTargets', { protein: 180, carbs: 250, fats: 70, calories: 2400 });
    $('#macro-protein-target').textContent = targets.protein;
    $('#macro-carbs-target').textContent = targets.carbs;
    $('#macro-fats-target').textContent = targets.fats;
    $('#macro-cal-target').textContent = targets.calories;

    // Populate target modal
    $('#target-protein').value = targets.protein;
    $('#target-carbs').value = targets.carbs;
    $('#target-fats').value = targets.fats;
    $('#target-calories').value = targets.calories;

    updateMacroRings();
    renderFoodLog();
  }

  function updateMacroRings() {
    const targets = store.get('macroTargets', { protein: 180, carbs: 250, fats: 70, calories: 2400 });
    const macroLog = store.get('foodLog_' + today(), []);
    const totals = macroLog.reduce((acc, f) => {
      acc.calories += f.calories; acc.protein += f.protein; acc.carbs += f.carbs; acc.fats += f.fats;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fats: 0 });

    setRing('ring-protein', totals.protein, targets.protein);
    setRing('ring-carbs', totals.carbs, targets.carbs);
    setRing('ring-fats', totals.fats, targets.fats);
    setRing('ring-calories', totals.calories, targets.calories);

    $('#macro-protein-current').textContent = Math.round(totals.protein);
    $('#macro-carbs-current').textContent = Math.round(totals.carbs);
    $('#macro-fats-current').textContent = Math.round(totals.fats);
    $('#macro-cal-current').textContent = Math.round(totals.calories);
  }

  function setRing(id, current, target) {
    const circumference = 2 * Math.PI * 52; // ~326.73
    const pct = Math.min(1, current / target);
    const offset = circumference * (1 - pct);
    document.getElementById(id).style.strokeDashoffset = offset;
  }

  function searchFood() {
    const query = $('#food-search').value.trim().toLowerCase();
    const container = $('#food-results');
    if (!query) { container.innerHTML = ''; return; }

    const fullDB = getFullFoodDB();
    const results = fullDB.filter(f => f.name.toLowerCase().includes(query));
    if (!results.length) {
      container.innerHTML = '<p class="empty-state">No results found. Try creating a custom food!</p>';
      return;
    }

    container.innerHTML = results.map((f, i) => `
      <div class="food-result-item" data-name="${f.name}">
        <div class="food-result-info">
          <h4>${highlightMatch(f.name, query)}${f.isCustom ? ' <span class="badge">Custom</span>' : ''}</h4>
          <small>P: ${f.protein}g · C: ${f.carbs}g · F: ${f.fats}g</small>
        </div>
        <span class="food-result-cals">${f.calories} kcal</span>
      </div>`).join('');

    $$('.food-result-item', container).forEach(item => {
      item.addEventListener('click', () => {
        const name = item.dataset.name;
        selectedFood = fullDB.find(f => f.name === name);
        openFoodModal();
      });
    });
  }

  function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query);
    if (idx < 0) return text;
    return text.slice(0, idx) + '<span class="accent">' + text.slice(idx, idx + query.length) + '</span>' + text.slice(idx + query.length);
  }

  function openFoodModal() {
    if (!selectedFood) return;
    $('#food-modal-name').textContent = selectedFood.name;
    $('#food-servings').value = 1;
    updateFoodPreview();
    $('#food-modal').classList.remove('hidden');
  }

  function updateFoodPreview() {
    if (!selectedFood) return;
    const qty = parseFloat($('#food-servings').value) || 1;
    const unit = $('#food-unit').value;
    const multiplier = unit === 'grams' ? qty / 100 : qty;

    const preview = $('#food-macro-preview');
    preview.innerHTML = `
      <div class="macro-preview-item cal"><small>Calories</small><span>${Math.round(selectedFood.calories * multiplier)}</span></div>
      <div class="macro-preview-item pro"><small>Protein</small><span>${Math.round(selectedFood.protein * multiplier)}g</span></div>
      <div class="macro-preview-item carb"><small>Carbs</small><span>${Math.round(selectedFood.carbs * multiplier)}g</span></div>
      <div class="macro-preview-item fat"><small>Fats</small><span>${Math.round(selectedFood.fats * multiplier)}g</span></div>`;
  }

  function logFood(e) {
    e.preventDefault();
    if (!selectedFood) return;
    const qty = parseFloat($('#food-servings').value) || 1;
    const unit = $('#food-unit').value;
    const multiplier = unit === 'grams' ? qty / 100 : qty;

    const entry = {
      name: selectedFood.name,
      amountText: unit === 'grams' ? `${qty}g` : `${qty} serving${qty !== 1 ? 's' : ''}`,
      calories: Math.round(selectedFood.calories * multiplier),
      protein: Math.round(selectedFood.protein * multiplier),
      carbs: Math.round(selectedFood.carbs * multiplier),
      fats: Math.round(selectedFood.fats * multiplier),
      timestamp: Date.now()
    };

    const key = 'foodLog_' + today();
    const log = store.get(key, []);
    log.push(entry);
    store.set(key, log);

    $('#food-modal').classList.add('hidden');
    selectedFood = null;
    updateMacroRings();
    renderFoodLog();
    toast(entry.name + ' logged');
  }

  function renderFoodLog() {
    const log = store.get('foodLog_' + today(), []);
    const container = $('#food-log');
    const totalContainer = $('#food-log-total');

    if (!log.length) {
      container.innerHTML = '<p class="empty-state">No food logged yet today. Start fueling!</p>';
      totalContainer.innerHTML = '';
      return;
    }

    container.innerHTML = log.map((f, i) => `
      <div class="food-log-item">
        <div class="food-log-item-info">
          <h4>${f.name} <small class="accent">${f.amountText ? '(' + f.amountText + ')' : (f.servings && f.servings !== 1 ? '(×' + f.servings + ')' : '')}</small></h4>
          <small>${Math.round(f.calories)} kcal · P: ${Math.round(f.protein)}g · C: ${Math.round(f.carbs)}g · F: ${Math.round(f.fats)}g</small>
        </div>
        <button data-remove-food="${i}" title="Remove">✕</button>
      </div>`).join('');

    $$('[data-remove-food]', container).forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.removeFood);
        const log = store.get('foodLog_' + today(), []);
        log.splice(idx, 1);
        store.set('foodLog_' + today(), log);
        updateMacroRings();
        renderFoodLog();
      });
    });

    const totals = log.reduce((acc, f) => {
      acc.calories += f.calories; acc.protein += f.protein; acc.carbs += f.carbs; acc.fats += f.fats;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fats: 0 });

    totalContainer.innerHTML = `
      <span>Total</span>
      <span>${Math.round(totals.calories)} kcal · P: ${Math.round(totals.protein)}g · C: ${Math.round(totals.carbs)}g · F: ${Math.round(totals.fats)}g</span>`;
  }

  function saveTargets(e) {
    e.preventDefault();
    const targets = {
      protein: parseInt($('#target-protein').value) || 180,
      carbs: parseInt($('#target-carbs').value) || 250,
      fats: parseInt($('#target-fats').value) || 70,
      calories: parseInt($('#target-calories').value) || 2400,
    };
    store.set('macroTargets', targets);
    $('#targets-modal').classList.add('hidden');
    renderMacros();
    toast('Macro targets updated');
  }

  // ——— CUSTOM FOOD DATABASE ———
  function openCustomFoodModal() {
    $('#custom-food-modal').classList.remove('hidden');
    renderCustomFoodsList();
  }

  function saveCustomFood(e) {
    e.preventDefault();
    const name = $('#custom-food-name').value.trim();
    const serving = $('#custom-food-serving').value.trim();
    const calories = parseFloat($('#custom-food-calories').value) || 0;
    const protein = parseFloat($('#custom-food-protein').value) || 0;
    const carbs = parseFloat($('#custom-food-carbs').value) || 0;
    const fats = parseFloat($('#custom-food-fats').value) || 0;

    if (!name) return toast('Enter a food name');
    if (!serving) return toast('Enter a serving size');
    if (calories <= 0) return toast('Enter valid calories');

    const displayName = name + ' (' + serving + ')';
    const customs = store.get('customFoods', []);

    // Check for duplicate names
    if (customs.some(f => f.name === displayName)) {
      return toast('A food with this name already exists');
    }

    customs.push({ name: displayName, calories, protein, carbs, fats, isCustom: true });
    store.set('customFoods', customs);
    $('#custom-food-form').reset();
    renderCustomFoodsList();
    toast(name + ' saved to My Foods');
  }

  function renderCustomFoodsList() {
    const customs = store.get('customFoods', []);
    const container = $('#custom-foods-list');
    const countBadge = $('#custom-food-count');
    countBadge.textContent = customs.length;

    if (!customs.length) {
      container.innerHTML = '<p class="empty-state">No custom foods yet. Create one above!</p>';
      return;
    }

    container.innerHTML = customs.map((f, i) => `
      <div class="custom-food-item">
        <div class="custom-food-item-info">
          <h4>${f.name}</h4>
          <small>${f.calories} kcal · P: ${f.protein}g · C: ${f.carbs}g · F: ${f.fats}g</small>
        </div>
        <div class="custom-food-item-actions">
          <button class="btn-use" data-use-custom="${i}" title="Quick log">＋</button>
          <button class="btn-del" data-del-custom="${i}" title="Delete">✕</button>
        </div>
      </div>`).join('');

    // Quick-use: opens food modal with this custom food
    $$('[data-use-custom]', container).forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.useCustom);
        selectedFood = customs[idx];
        $('#custom-food-modal').classList.add('hidden');
        openFoodModal();
      });
    });

    // Delete
    $$('[data-del-custom]', container).forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.delCustom);
        const customs = store.get('customFoods', []);
        const removed = customs.splice(idx, 1)[0];
        store.set('customFoods', customs);
        renderCustomFoodsList();
        toast(removed.name + ' removed');
      });
    });
  }

  // ——— Event Listeners ———
  async function init() {
    // Onboarding
    $('#onboarding-form').addEventListener('submit', calculateTDEE);
    $('#ob-finish').addEventListener('click', finishOnboarding);
    $('#btn-recalc-tdee').addEventListener('click', () => {
      $('#onboarding-step-1').classList.remove('hidden');
      $('#onboarding-step-2').classList.add('hidden');
      $('#onboarding-modal').classList.remove('hidden');
    });
    $('#btn-profile').addEventListener('click', () => {
      $('#onboarding-step-1').classList.remove('hidden');
      $('#onboarding-step-2').classList.add('hidden');
      $('#onboarding-modal').classList.remove('hidden');
    });
    $('#btn-mobile-profile').addEventListener('click', () => {
      $('#onboarding-step-1').classList.remove('hidden');
      $('#onboarding-step-2').classList.add('hidden');
      $('#onboarding-modal').classList.remove('hidden');
    });


    // Auth
    $('#btn-signup').addEventListener('click', () => showAuthModal('signup'));
    $('#btn-signin').addEventListener('click', () => showAuthModal('signin'));
    $('#auth-close').addEventListener('click', () => $('#auth-modal').classList.add('hidden'));
    $('#auth-form').addEventListener('submit', handleAuth);
    $('#btn-logout').addEventListener('click', logout);

    // Paywall
    $('#btn-pay').addEventListener('click', async () => {
      const phoneInput = $('#pay-phone');
      const errEl = $('#paywall-error');
      
      if (!phoneInput || !phoneInput.value.trim() || phoneInput.value.length < 10) {
        errEl.textContent = 'Please enter a valid 10-digit phone number.';
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';

      const btn = $('#btn-pay');
      const origText = btn.textContent;
      btn.textContent = 'Initializing...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/payment/easebuzz/initiate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + authToken
          },
          body: JSON.stringify({ phone: phoneInput.value.trim() })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
          errEl.textContent = data.error || 'Failed to initiate payment.';
          errEl.style.display = 'block';
          btn.textContent = origText;
          btn.disabled = false;
          return;
        }

        // Redirect to Easebuzz
        window.location.href = `https://testpay.easebuzz.in/pay/${data.access_key}`;
      } catch (err) {
        console.error('Payment error', err);
        errEl.textContent = 'Network error. Please try again.';
        errEl.style.display = 'block';
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
    $('#btn-paywall-logout').addEventListener('click', () => {
      $('#paywall-modal').classList.add('hidden');
      logout();
    });

    // Dashboard
    $('#btn-log-weight').addEventListener('click', logWeight);
    $('#weight-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); logWeight(); } });

    // Strength
    $('#btn-add-set').addEventListener('click', addSet);
    $('#btn-remove-set').addEventListener('click', removeSet);
    $('#btn-log-exercise').addEventListener('click', logExercise);
    $('#history-filter').addEventListener('change', renderWorkoutHistory);

    // Macros
    $('#food-search').addEventListener('input', searchFood);
    $('#btn-food-search').addEventListener('click', searchFood);
    $('#food-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchFood(); } });
    $('#btn-set-targets').addEventListener('click', () => $('#targets-modal').classList.remove('hidden'));
    $('#targets-close').addEventListener('click', () => $('#targets-modal').classList.add('hidden'));
    $('#targets-form').addEventListener('submit', saveTargets);
    $('#food-close').addEventListener('click', () => $('#food-modal').classList.add('hidden'));

    // Custom Food
    $('#btn-custom-food').addEventListener('click', openCustomFoodModal);
    $('#custom-food-close').addEventListener('click', () => $('#custom-food-modal').classList.add('hidden'));
    $('#custom-food-form').addEventListener('submit', saveCustomFood);
    $('#food-log-form').addEventListener('submit', logFood);
    $('#food-servings').addEventListener('input', updateFoodPreview);
    $('#food-unit').addEventListener('change', () => {
      // Automatically adjust standard input value roughly depending on switch
      const unit = $('#food-unit').value;
      if (unit === 'grams') {
        $('#food-servings').value = 100;
      } else {
        $('#food-servings').value = 1;
      }
      updateFoodPreview();
    });

    // Close modals on backdrop
    $$('.modal-overlay').forEach(m => {
      m.addEventListener('click', (e) => { 
        if (e.target === m) {
          if (m.id === 'paywall-modal' && m.dataset.locked === 'true') return;
          m.classList.add('hidden'); 
        }
      });
    });

    const upgradeBtn = $('#btn-upgrade-premium');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => showPaywall(true));
    }

    // ——— Initial auth check ———
    let hash = window.location.hash.slice(1);

    if (hash === 'payment-success') {
      toast('Payment successful! Welcome to Premium Access.');
      window.location.hash = 'dashboard';
      hash = 'dashboard';
    } else if (hash === 'payment-failure') {
      toast('Payment failed. Please try again.');
      window.location.hash = 'dashboard';
      hash = 'dashboard';
    }

    if (authToken) {
      const valid = await checkAuthStatus();
      if (valid) {
        // Check trial
        if (trialInfo && trialInfo.trialExpired) {
          showPaywall();
          return;
        } else {
          $('#paywall-modal').classList.add('hidden');
        }

        updateTrialBanner();

        if (!store.get('onboardingComplete', false)) {
          $('#onboarding-step-1').classList.remove('hidden');
          $('#onboarding-step-2').classList.add('hidden');
          $('#onboarding-modal').classList.remove('hidden');
        }

        if (pages.includes(hash)) {
          navigate(hash);
        } else {
          navigate('dashboard');
        }
      } else {
        navigate('landing');
      }
    } else {
      navigate('landing');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
