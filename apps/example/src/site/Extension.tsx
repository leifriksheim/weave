import { EXTERNAL, Feature, GITHUB, Page } from './Site';

/**
 * The Chrome extension (`apps/extension`), and how to install it by hand until
 * it is in the Chrome Web Store. The zip is built with the site
 * (`netlify.toml`), so it always matches what is deployed.
 */

const DOWNLOAD = '/weave-chrome.zip';
const SOURCE = `${GITHUB}/tree/main/apps/extension`;

export function Extension() {
  return (
    <Page page="extension">
      <section className="hero">
        <div className="wrap">
          <h1>
            Your spaces, awake
            <br />
            while Chrome is.
          </h1>
          <p>
            The Weave extension keeps your spaces moving with every app closed, and tells you when something
            you care about happens. It can’t read a word of them.
          </p>
          <div className="actions">
            <a href={DOWNLOAD} className="btn btn-primary" download>
              Download for Chrome
            </a>
            <a href="#install" className="btn btn-secondary">
              How to install
            </a>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Why you want it</div>
            <h2>Without it, your data only moves while an app is open.</h2>
            <p>
              Weave has no server holding your spaces. Write something and close the tab, and it waits until
              one of your devices and the app are online together. With the extension, Chrome is always there
              to pass it on.
            </p>
          </div>
          <div className="grid">
            <Feature icon="M2 8h3l2-5 2 10 2-5h3" title="Always in sync">
              Your phone gets your laptop’s changes the moment it comes online, even if the laptop’s tabs are
              long closed.
            </Feature>
            <Feature icon="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 14h3" title="Notifications, privately">
              New messages in a space, ones that mention you, ones in #design. You pick, and it matches them
              without learning what you asked for.
            </Feature>
            <Feature icon="M2.5 3.5h11v8h-11zM6 14h4" title="Your friends reach you">
              A message sent while every app of yours is closed still reaches you, instead of waiting for you
              to open one.
            </Feature>
            <Feature icon="M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3z" title="It can’t read them">
              It holds a pass for each space, not its key. Records stay locked, as they travel. It sees what a
              relay sees: who, when, and which collection.
            </Feature>
            <Feature icon="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" title="No access to your sites">
              No content scripts and no host permissions, so Chrome shows no warning about reading your data
              on websites.
            </Feature>
            <Feature icon="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4" title="Open source">
              Every line is in the Weave repository, and it checks every record the same way every other
              device does.
            </Feature>
          </div>
        </div>
      </section>

      <section className="band" id="install">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Install</div>
            <h2>Three steps, until it’s in the Chrome Web Store.</h2>
            <p>
              The listing is on its way. For now, Chrome loads the extension from a folder on your computer.
            </p>
          </div>
          <div className="steps">
            <div className="step">
              <h3>Download and unzip</h3>
              <p>
                <a href={DOWNLOAD} download>
                  Download the zip
                </a>{' '}
                and unzip it somewhere it can stay, like your Documents folder. Chrome runs it from there.
              </p>
            </div>
            <div className="step">
              <h3>Load it in Chrome</h3>
              <p>
                Open <code>chrome://extensions</code>, turn on <b>Developer mode</b> at the top right, click{' '}
                <b>Load unpacked</b> and choose the folder.
              </p>
            </div>
            <div className="step">
              <h3>Connect your account</h3>
              <p>
                A welcome tab opens. Connect it to your account home and approve it there. Pin it from the
                puzzle-piece menu: a green dot on its icon means it’s keeping your spaces online.
              </p>
            </div>
          </div>
          <div className="split" style={{ marginTop: 72 }}>
            <div>
              <div className="kicker-inline">Updating</div>
              <h3>Replace the folder, then reload.</h3>
            </div>
            <div>
              <p>
                An extension loaded this way doesn’t update itself. To get a newer one, download the zip
                again, unzip it over the same folder, and press the reload button on Weave’s card in{' '}
                <code>chrome://extensions</code>. Keep the folder where it is, and you stay connected.
              </p>
              <p>
                Want to build it yourself? The{' '}
                <a href={SOURCE} {...EXTERNAL}>
                  source and build steps
                </a>{' '}
                are on GitHub.
              </p>
            </div>
          </div>
        </div>
      </section>
    </Page>
  );
}
