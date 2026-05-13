# Screenshot guide

The Chrome Web Store accepts **up to 5 screenshots**, each PNG or JPEG, at
either **1280×800** or **640×400**. Use 1280×800 — it's the size shown on
the listing page. You need **at least one**; more is better.

## How to capture (Chrome DevTools method — recommended)

This method gives you exact 1280×800 pixels regardless of your monitor size.

1. Open a great-looking `.md` file in Chrome with the extension active.
2. Press **F12** to open DevTools.
3. Click the **device-toolbar icon** (top-left of DevTools, looks like a
   phone) or press **Cmd+Shift+M** (macOS) / **Ctrl+Shift+M** (Win/Linux).
4. In the device-emulation bar at the top:
   - Set **Responsive** as the device.
   - Type **1280** × **800** into the dimension boxes.
   - Set **DPR** (device pixel ratio) to **1.0**.
5. Scroll the page to the part you want to capture.
6. Open the DevTools command menu: **Cmd+Shift+P** / **Ctrl+Shift+P**.
7. Type **"Capture screenshot"** and pick:
   - **"Capture screenshot"** — captures the visible 1280×800 viewport
     (recommended for store listings).
   - **"Capture full size screenshot"** — captures the entire scrollable
     page (good for a vertical "feature tour" image, but it'll be taller
     than 800px so you'd need to crop).

You'll get a PNG download. Verify dimensions: right-click → Get Info / Properties.

## macOS quick alternative

Press **Cmd+Shift+5**, drag a 1280×800 region. Less precise — the Chrome
DevTools method is preferred for store-quality assets.

## Recommended 5 shots

Plan the screenshots as a small "feature tour". Order matters: the first
screenshot is the one shown in search results.

| # | Subject | Why it sells |
|---|---------|--------------|
| 1 | **Hero shot.** A long `.md` open in the browser, sidebar TOC visible on the left, a clean LaTeX equation (e.g. `$\int e^{-x^2}dx = \sqrt\pi$`) and a syntax-highlighted code block both visible in the viewport. | This is what people see in search results. It must immediately telegraph "math + code + structure". |
| 2 | **Math close-up.** Zoomed-in section showing several formulas: an inline fraction, a display-mode integral, a `\begin{aligned}` block. | Proves the headline feature actually works and looks good. |
| 3 | **Code boundary case.** A Python or JS code block containing `$x$` or `$$...$$` literals, plus a real formula in the surrounding prose. Caption (overlay) optional: "Dollar signs inside code stay literal." | Differentiator — the #1 reason existing viewers fail. |
| 4 | **TOC in action.** Page scrolled mid-document, sidebar showing the active section highlighted, nested headings expanded. Optionally show the `»` collapsed handle as a separate frame. | Shows the navigation feature explicitly. |
| 5 | **Dark mode.** Same content as shot #1 but in dark theme (set macOS / Windows to dark mode, reload). | Reassures users who live in dark mode. |

## Tips

- **Use the test.md fixture as your demo file.** It already exercises
  formulas, code, tables, lists, and CJK content. To keep the screenshots
  in English, write a quick demo .md instead — see "Demo Markdown" below.
- **Hide the bookmarks bar** (`Cmd+Shift+B` to toggle) and other browser
  chrome — the screenshot looks more polished.
- **Use a fresh browser profile** to avoid leaking your tabs/history into
  the screenshot.
- **Real content > Lorem Ipsum.** Pick something credible: notes on a real
  algorithm, a chapter from a textbook, a paper abstract. Reviewers and
  users notice.
- **No watermarks, no UI mockups.** Chrome Web Store rejects screenshots
  that aren't actual product UI.

## Demo Markdown (English-only, for screenshots 1–4)

Save this as `demo.md` somewhere convenient and open in Chrome. The outer
fence uses four backticks so the inner three-backtick blocks for `python`
and the document end are preserved verbatim as the demo's content (per the
CommonMark rule that a closing fence must be at least as long as the open).

````markdown
# Diffusion Models: A Quick Refresher

## 1. The Forward Process

A diffusion model corrupts data $x_0$ by progressively adding Gaussian noise:

$$
q(x_t \mid x_{t-1}) = \mathcal{N}\!\left(x_t;\, \sqrt{1 - \beta_t}\, x_{t-1},\, \beta_t I\right)
$$

The variance schedule $\{\beta_t\}_{t=1}^T$ controls how aggressively noise
is injected. A common choice is the linear schedule.

## 2. Sampling Code

```python
def sample(model, T, shape):
    x = torch.randn(shape)            # x_T ~ N(0, I)
    for t in reversed(range(T)):
        eps = model(x, t)             # predicted noise
        # mean of p(x_{t-1} | x_t)
        x = (x - (1 - alpha[t]) / sqrt(1 - alpha_bar[t]) * eps) / sqrt(alpha[t])
        if t > 0:
            x = x + sigma[t] * torch.randn_like(x)
    return x
```

Note: `$x_t$` inside this code block is left literal — it is NOT a formula.

## 3. The Reverse Process

The learned reverse model parameterizes:

$$
p_\theta(x_{t-1} \mid x_t) = \mathcal{N}\!\big(x_{t-1};\, \mu_\theta(x_t, t),\, \Sigma_\theta(x_t, t)\big)
$$

| Quantity | Symbol | Typical range |
|----------|--------|---------------|
| Steps | $T$ | 1000 |
| Noise schedule | $\beta_t$ | $10^{-4} \to 0.02$ |
| Loss | $\mathcal{L}_\text{simple}$ | MSE on $\varepsilon$ |
````

### Live reference: this is what those formulas look like when rendered

The `$$...$$` blocks above are inside the code fence, so they appear as
literal LaTeX source. The same formulas below are NOT inside a fence, so
the extension renders them — handy as a side-by-side sanity check when
opening this file in the viewer.

Inline: $x_0$, $\beta_t$, $\mathcal{L}_\text{simple}$.

Forward process:

$$
q(x_t \mid x_{t-1}) = \mathcal{N}\!\left(x_t;\, \sqrt{1 - \beta_t}\, x_{t-1},\, \beta_t I\right)
$$

Reverse process:

$$
p_\theta(x_{t-1} \mid x_t) = \mathcal{N}\!\big(x_{t-1};\, \mu_\theta(x_t, t),\, \Sigma_\theta(x_t, t)\big)
$$

For shot #3 specifically, scroll to the Python code block (section 2) so
both the code containing `$x_t$` AND a real formula above it are visible.

## After capturing

Sanity-check each screenshot:

- Exactly 1280×800 (or 640×400) pixels
- No personal info (open tabs, bookmarks, profile picture)
- No DevTools panel visible
- Text is readable — if zoom level was below 100%, redo at 100%
- File size under 5MB (PNG is fine, JPEG is usually smaller)

When you're happy, drop them into the store dashboard's "Screenshots" section.
