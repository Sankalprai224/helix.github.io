# Layout Specification: Hugging Face Aesthetic Overhaul

## 1. Objective
Update the blog architecture and styling to mirror the sleek, highly readable layout of the Hugging Face engineering blog. This design prioritizes a prominent "Hero" header, legible data tables (crucial for tokenizer benchmarking comparisons), a strict central column width, and clean typography.

## 2. Structural Updates (`_layouts/post.html`)
* **Hero Section:** Create a top Hero section by wrapping the `<h1>` title within a `<header class="post-hero">` block.
* **Post Metadata:** Immediately below the `<h1>`, insert a `<div class="post-meta">` block containing:
    * **Author:** Sankalp
    * **Publish Date:** Format using Liquid syntax `{{ page.date | date: "%B %d, %Y" }}`
    * **Reading Time:** Include an estimated reading time calculation.

## 3. Styling Engine Overhaul (`assets/css/style.css`)
* **Typography:**
    * Apply a modern sans-serif font stack globally: `'Inter', system-ui, sans-serif`.
    * Style the `<h1>` to be massive (`2.5rem` or `3rem`), utilizing tight `letter-spacing` and a bold font weight (`700` or `800`).
* **Layout & Spacing:**
    * Center the `<main>` content container.
    * Enforce a strict `max-width: 768px;` for the main text column to perfectly match the Hugging Face reading experience.
* **Data Tables:**
    * Force `<table>` elements to take up `100%` of the container width.
    * Apply a light `border-bottom` to all `<th>` and `<td>` elements.
    * Align all table text to the left.
    * Add generous padding (`12px 16px`) to all table cells.
    * *Dark Mode Constraint:* The table header row must have a slightly lighter background color than the table body to create visual distinction.
* **Code Blocks:**
    * Style all `<pre>` and `<code>` blocks with rounded corners (`border-radius: 8px`).
    * Apply generous padding (`16px`).
    * Use a distinct background color that pops against the main site background.
    * Enforce `overflow-x: auto;` to prevent long lines of code from breaking the horizontal layout.
* **Blockquotes (Callouts/TL;DR):**
    * Style blockquotes with a thick left border using an accent color (e.g., a subtle cyan).
    * Apply a slightly faded text color to visually distinguish the blockquote from the primary body text.