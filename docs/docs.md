versatile.js
============

*Versatile* is a hybrid content/view engine designed to make it super easy to
both create and deploy content using a flat file format of your choice but
without losing the power of templating, layouts, partial views and so forth.

In most view engines, the content and other data is injected into the view,
which usually uses a particular templating format, depending on what you're
using and how you've configured it, and the view then renders the specified
values and merges itself into some master layout hierarchy to produce a final
page.

In contrast, *Versatile* doesn't distinguish between content, views, templates
and layouts, but rather merges all of these concepts into a single *versatile*
format we can simply call a "document". Any document can be a layout for another
document, and any document can be embedded in any other document like a partial
view. Best of all, document content can be in any combination of formats you
choose and requires essentially zero knowledge of *versatile* concepts to get
started.