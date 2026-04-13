# Pi Steel Testing Prompts

Use these prompts with Pi after loading the extension, for example:

```bash
pi -e /Users/nikola/dev/steel/steel-pi/dist/index.js
```

## Basic Flow

- `Use steel_navigate to open https://example.com and tell me the page title.`
- `Use steel_navigate to open https://news.ycombinator.com and then use steel_get_url and steel_get_title.`
- `Use steel_navigate to open https://httpbin.org/forms/post and tell me the final URL after navigation.`

## Scraping

- `Use steel_navigate to open https://example.com, then use steel_scrape in text format and return the extracted text.`
- `Use steel_navigate to open https://news.ycombinator.com, then use steel_scrape in markdown format and summarize the first five headlines.`
- `Use steel_navigate to open https://example.com and use steel_scrape with maxChars 300.`

## Screenshots And PDF

- `Use steel_navigate to open https://example.com, then save a full-page screenshot with steel_screenshot and tell me the artifact path.`
- `Use steel_navigate to open https://news.ycombinator.com, then capture a screenshot of the first story link using steel_screenshot with a selector.`
- `Use steel_navigate to open https://example.com and save the page as a PDF with steel_pdf.`

## Finding And Clicking

- `Use steel_navigate to open https://news.ycombinator.com, then use steel_find_elements to find the login link.`
- `Use steel_navigate to open https://news.ycombinator.com, use steel_find_elements to identify the login link, then click it with steel_click and tell me the new URL.`
- `Use steel_navigate to open https://example.com and use steel_find_elements to list clickable elements.`

## Typing And Forms

- `Use steel_navigate to open https://httpbin.org/forms/post, then use steel_type to enter "Nikola" into input[name="custname"].`
- `Use steel_navigate to open https://httpbin.org/forms/post, then use steel_fill_form to fill customer name, telephone, and email fields.`
- `Use steel_navigate to open https://httpbin.org/forms/post, fill the form fields you can identify, and report which selectors succeeded or failed.`

## Waiting And Dynamic Behavior

- `Use steel_navigate to open https://example.com and then use steel_wait for the h1 element to become visible.`
- `Use steel_navigate to open https://news.ycombinator.com and use steel_wait on the .athing selector with a 5000ms timeout.`
- `Use steel_navigate to open https://example.com, wait for the body to be visible, then tell me the title.`

## History And Navigation Utilities

- `Use steel_navigate to open https://example.com, then navigate to https://news.ycombinator.com, then use steel_go_back and tell me the URL and title.`
- `Use steel_navigate to open https://example.com and then use steel_get_url.`
- `Use steel_navigate to open https://example.com and then use steel_get_title.`

## Scroll

- `Use steel_navigate to open https://news.ycombinator.com, then use steel_scroll to move down 1200 pixels and report the scroll result.`
- `Use steel_navigate to open https://news.ycombinator.com, scroll down, then take a screenshot.`

## Computer Tool

- `Use steel_navigate to open https://example.com, then use steel_computer with action take_screenshot and tell me where the image was saved.`
- `Use steel_navigate to open https://example.com, then use steel_computer with action get_cursor_position.`
- `Use steel_navigate to open https://example.com, then use steel_computer with action wait for 1000ms.`

## Structured Extraction

- `Use steel_navigate to open https://example.com, then use steel_extract with a schema that returns the page title and the main heading text.`
- `Use steel_navigate to open https://news.ycombinator.com, then use steel_extract with a schema for the first 5 story titles and URLs.`
- `Use steel_navigate to open https://httpbin.org/forms/post, then use steel_extract with a schema describing the visible form fields.`

## Edge Cases

- `Use steel_navigate to open localhost:3000 and tell me the normalized URL and title.`
- `Use steel_navigate to open HTTP://example.com/path and tell me the final URL.`
- `Use steel_navigate to open ftp://example.com and tell me exactly why it fails.`

## End-To-End Smoke Tests

- `Use steel_navigate to open https://news.ycombinator.com, get the title, scrape the first few headlines, and save a screenshot.`
- `Use steel_navigate to open https://httpbin.org/forms/post, fill some fields, take a screenshot, and summarize what happened.`
- `Use steel_navigate to open https://example.com, confirm the title, extract the main content, save a PDF, and report all artifacts.`
