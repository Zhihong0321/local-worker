"""Quick verification script for Scrapling installation."""
from scrapling.parser import Adaptor

html = """
<html>
  <head><title>Test Page</title></head>
  <body>
    <div class="content">
      <h1 id="title">Scrapling Works!</h1>
      <p class="desc">Adaptive web scraping framework is operational.</p>
    </div>
  </body>
</html>
"""

page = Adaptor(html)
title = page.find("#title").text
desc = page.find(".desc").text

print("[VERIFICATION SUCCESS]")
print(f"Title: {title}")
print(f"Description: {desc}")
