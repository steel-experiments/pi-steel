# Testing `pi-steel`

Prompts for proving the extension works end to end inside `pi`. One prompt per line. Phrased the way a person would actually ask. Run each at least three times — web agents are noisy.

Load the extension:

```bash
pi -e /Users/nikola/dev/steel/steel-pi/dist/index.js
```

Or from this repo:

```bash
pi -e .
```

Unit tests:

```bash
npm test
```

## Navigation and page identity

Open https://example.com and tell me the page title and the final URL.
Open https://example.com, then go back, and tell me where you ended up.
Open https://example.com, then open https://news.ycombinator.com, then go back, and confirm you are on example.com again.
Open https://httpstat.us/404 and tell me exactly what you see and what the URL resolved to.
Try to open http://this-domain-should-not-exist-123.invalid and report the exact error without guessing.

## Screenshots and PDFs

Open https://example.com and save a full-page screenshot. Give me the artifact path.
Open https://example.com and save both a screenshot and a PDF. Confirm the two files are distinct and tell me their paths.
Open https://news.ycombinator.com and take a screenshot of just the top navigation bar. Tell me which selector you used.
Open https://example.com and try to screenshot a selector that does not exist. When that fails, recover with a full-page screenshot and report both attempts.

## Scraping and extracting

Open https://example.com, scrape the page as markdown, and quote the main heading back to me.
Open https://news.ycombinator.com and give me the first five story titles with their links as structured data.
Open https://news.ycombinator.com, extract the first five story titles, then scrape the page as markdown, and confirm each extracted title actually appears in the scrape.
Open https://httpbin.org/forms/post and list every visible form field with its label and type.
Open https://example.com and tell me the visible text content in under 200 characters.

## Finding and clicking

Open https://news.ycombinator.com and find the login link. Give me the top selector candidates and why you chose each.
Open https://news.ycombinator.com, click the login link, and tell me the new page title and URL.
Open https://news.ycombinator.com, click the login link, then go back, and prove you are on the front page again.
Open https://news.ycombinator.com and click a selector that definitely does not exist. Return the raw error and whether the URL changed.

## Forms and typing

Open https://httpbin.org/forms/post, fill in the customer name and telephone fields only, and return both the intended values and what the page actually shows in those fields.
Open https://duckduckgo.com, type "steel browser" into the search box, submit, and give me the first three result titles.
Open https://httpbin.org/forms/post, try to fill a field that does not exist, and report the exact failure instead of pretending it worked.

## Scrolling and waiting

Open https://news.ycombinator.com, scroll to the bottom, and tell me the last visible story title.
Open https://news.ycombinator.com, scroll down two viewports, extract five currently visible story titles, and confirm they appear in the scraped markdown after scrolling.
Open https://example.com and wait for `h1` to appear before reading the page title.
Open https://example.com and wait for a selector that will never appear with a 3 second timeout. Report the timeout cleanly.

## Session reuse

Pin a session, open https://example.com, then in the same session open https://news.ycombinator.com, and confirm both pages were handled by the same browser instance.
Pin a session, open https://news.ycombinator.com, click the login link, then release the session and tell me what state you left it in.
Run two navigations back to back without pinning, and tell me whether a new session was created for each or the session was reused.

## Truthfulness

Open https://example.com and tell me the color of every visible button. If there are no visible buttons, say so explicitly instead of inventing any.
Open https://news.ycombinator.com and tell me whether there is a "Buy now" button. Do not claim it exists unless you can point to tool evidence.
Open https://example.com and list every image on the page with its alt text. If there are no images, say that.

## Recovery

Open https://news.ycombinator.com, try to click "Sign out", and when it fails, fall back to clicking "login" and report both attempts.
Open https://example.com, try to extract a "pricing table", and when there is none, say so and offer what is actually on the page instead.
Open https://httpbin.org/delay/5 with a 2 second timeout, let it fail, then retry with a longer timeout and report both runs.

## End-to-end journeys

Open https://news.ycombinator.com, capture the first five story titles, take a screenshot, click through to the first story's comments page, and give me the story title, the comments URL, and both artifact paths.
Open https://example.com, save a screenshot and a PDF, then navigate to https://news.ycombinator.com, save another screenshot, and return all three artifact paths with the URL each came from.
Open https://duckduckgo.com, search for "hacker news", click the first organic result, confirm the final URL is news.ycombinator.com, and return a screenshot of the landing page.

## WebVoyager tasks

Borrowed verbatim from the WebVoyager benchmark (https://github.com/MinorJerry/WebVoyager). Real sites, one clear goal, one checkable answer. Good for comparing our agent to published numbers.

### Friendly sites (no login, no heavy bot walls)

Find a recipe for a vegetarian lasagna that has at least a four-star rating and uses zucchini on https://www.allrecipes.com.
Find a five-star rated chocolate chip cookie recipe that takes less than 1 hour to make on https://www.allrecipes.com and tell me how many reviews it has.
Compare the prices of the latest models of MacBook Air available on https://www.apple.com.
Search https://arxiv.org for the latest preprints about "quantum computing" and give me the top three titles with authors.
Read the latest health-related news article published on https://www.bbc.com/news and summarize the key points.
Find the pronunciation, definition, and a sample sentence for the word "serendipity" on https://dictionary.cambridge.org.
Search https://www.coursera.org for a beginner-level course on Python programming suitable for someone with no programming experience, and give me the top result.
Look up the current standings for the NBA Eastern Conference on https://www.espn.com.
Search https://github.com for an open-source project related to "climate change data visualization" and report the project with the most stars.
Find a pre-trained sentiment analysis model on https://huggingface.co and return its name, downloads, and last update date.
Ask https://www.wolframalpha.com for the derivative of x^2 at x = 5.6 and report the answer it returns.
Use https://www.google.com to find the initial release date of "Guardians of the Galaxy Vol. 3" and return the date plus the source snippet.

### Hard sites (bot walls, captchas, heavy JS)

Search https://www.amazon.com for an Xbox Wireless controller in green color rated above 4 stars and return the top result with price and rating.
Find the cheapest available hotel room on https://www.booking.com for a three night stay starting 1 January in Jakarta for 2 adults, and return the hotel name and price.
On https://www.google.com/travel/flights, show me one-way flights from Chicago to Paris for next Saturday and return the three cheapest options.
Find 5 beauty salons with ratings greater than 4.8 in Seattle, WA on https://www.google.com/maps and return names, ratings, and addresses.

## Output contract

For anything above where you care about grading, append:

> Return JSON only with: task, status (success | partial | failure), tools_used, observed (raw facts from tool output), artifacts, errors, notes (your conclusions). Do not claim success without tool evidence.
