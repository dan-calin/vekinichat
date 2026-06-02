import { signUp, signIn } from '../auth.js';

export function setupAuthUI() {
    const $ = (sel) => document.querySelector(sel);
    
    const loginForm = $('#login-form');
    const signupForm = $('#signup-form');
    const authError = $('#auth-error');
    const authSubtitle = $('#auth-subtitle');
    const toggleText = $('#toggle-text');
    const toggleBtn = $('#toggle-auth');

    let isSignUp = false;

    function toggleAuthMode() {
        isSignUp = !isSignUp;
        loginForm.classList.toggle('hidden', isSignUp);
        signupForm.classList.toggle('hidden', !isSignUp);
        authSubtitle.textContent = isSignUp ? 'Create your account' : 'Sign in to continue';
        toggleText.textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
        toggleBtn.textContent = isSignUp ? 'Sign In' : 'Sign Up';
        hideError();
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleAuthMode);
    }

    function showError(msg) {
        authError.textContent = msg;
        authError.classList.remove('hidden');
    }

    function hideError() {
        authError.classList.add('hidden');
        authError.textContent = '';
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();
            const btn = $('#login-btn');
            const email = $('#login-email').value.trim();
            const password = $('#login-password').value;

            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span>';
            try {
                await signIn(email, password);
            } catch (err) {
                showError(err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Sign In';
            }
        });
    }

    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();
            const btn = $('#signup-btn');
            const username = $('#signup-username').value.trim();
            const email = $('#signup-email').value.trim();
            const password = $('#signup-password').value;

            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span>';
            try {
                await signUp(email, password, username);
            } catch (err) {
                showError(err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Create Account';
            }
        });
    }
}
