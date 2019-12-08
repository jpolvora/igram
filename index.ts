import { format } from "util";
import { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError, AccountRepositoryLoginResponseLogged_in_user } from "instagram-private-api";
import { get } from "lodash";
import { prompt } from "inquirer";
import { join, extname } from "path";
import { readJSONSync, writeJSONSync, existsSync, readdirSync, pathExists } from "fs-extra";
import slug from "slug";
const username = process.env.IG_USERNAME;
const password = process.env.IG_PASSWORD;
const credentialsFile = username => join(__dirname, `./${slug(username)}.credentials.json`);
const unfollowedFile = username => join(__dirname, `./${slug(username)}.unfollowed.json`);
const followingFile = (username, seq) => join(__dirname, `./${slug(username)}.${seq}.json`);

function printMessage(message, ...args) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(format(message, ...args));
}

function stateSave(data: object) {
  writeJSONSync(credentialsFile(username), data);
  return data;
}

function save(fileName: string, data: object) {
  writeJSONSync(fileName, data, {
    spaces: 2
  });
}

function stateExists() {
  // here you would check if the data exists
  //return false;
  return existsSync(credentialsFile(username));
}

function stateLoad() {
  return readJSONSync(credentialsFile(username));
}

const ig = new IgApiClient();
ig.state.generateDevice(username);
//ig.state.proxyUrl = process.env.IG_PROXY;

async function tryLogin(error?: Error): Promise<AccountRepositoryLoginResponseLogged_in_user> {
  if (!error) {
    try {
      const auth = await ig.account.login(username, password);
      return auth;
    } catch (err) {
      return tryLogin(err);
    }
  }

  console.log("error: ", error);

  if (error instanceof IgLoginTwoFactorRequiredError) {
    const twoFactorIdentifier = get(error, "response.body.two_factor_info.two_factor_identifier");

    if (!twoFactorIdentifier) {
      throw new Error("Unable to login, no 2fa identifier found");
    }

    const result = await prompt([
      {
        type: "input",
        name: "code",
        message: "Enter code"
      }
    ]);

    if (!result.code) throw new Error("Invalid input");
    try {
      const twoFactorLoginResult = await ig.account.twoFactorLogin({
        username: username,
        verificationCode: result.code,
        twoFactorIdentifier
      });
      return twoFactorLoginResult;
    } catch (err) {
      return tryLogin(err);
    }
  } else if (error instanceof IgCheckpointError) {
    try {
      await ig.challenge.auto(true);

      const result = await prompt([
        {
          type: "input",
          name: "code",
          message: "Enter code"
        }
      ]);

      if (!result.code) throw new Error("invalid input");

      await ig.challenge.sendSecurityCode(result.code);

      return tryLogin();
    } catch (err) {
      return tryLogin(err);
    }
  } else {
    throw error;
  }
}
const delay = (time: number) => new Promise(res => setTimeout(res, time));

function getRandomArbitrary(min, max) {
  return Math.random() * (max - min) + min;
}

interface IUserInfo {
  sequence: number;
  id: number;
  username: string;
  full_name: string;
  followed_by: boolean;
  is_bestie: boolean;
  unfollow: Function;
}

async function loadFollowings(id: number): Promise<IUserInfo[]> {
  const following: IUserInfo[] = [];
  const followingFeed = ig.feed.accountFollowing(id);
  while (followingFeed.isMoreAvailable()) await followingFeed.items();
  const items = await followingFeed.items();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    following.push({
      id: item.pk,
      username: item.username,
      full_name: item.full_name,
      followed_by: false,
      unfollow: item.checkUnfollow.bind(item),
      sequence: i,
      is_bestie: false
    });
  }

  let counter = 0;
  let archive = 0;
  const maxRecords = 100;
  for (let j = 0; j < following.length; j++) {
    const user = following[j];
    const rnd = getRandomArbitrary(1, 100);
    printMessage("[%s/%s] (%s), delay: %d", j + 1, following.length, user.username, rnd);
    await delay(rnd);
    const info = await ig.friendship.show(user.id);
    user.followed_by = info.followed_by;
    user.is_bestie = info.is_bestie;
    user.sequence = j;

    if (counter === maxRecords) {
      counter = 0;
      save(followingFile(username, archive), following.slice(j - maxRecords, j));
      archive++;
    }
    counter++;
  }

  save(followingFile(username, archive), following.slice(maxRecords * archive, counter));

  return following;
}

async function loadFollowingsFromFiles(): Promise<IUserInfo[]> {
  const following: IUserInfo[] = [];

  const files = readdirSync(__dirname);
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (extname(file).toLowerCase() === ".json") {
      if (file.indexOf(".credentials") >= 0) continue;
      if (file.indexOf(".unfollowed") >= 0) continue;
      if (file.indexOf(`${slug(username)}.`) >= 0) {
        const data = readJSONSync(join(__dirname, file), { throws: true });
        for (let i = 0; i < data.length; i++) {
          const item = data[i];
          following.push(item);
        }
      }
    }
  }

  return following;
}

async function doUnfollow(following: IUserInfo[]) {
  const unfollowedPeople = [];

  for (let k = 0; k < following.length; k++) {
    const user = following[k];
    if (user.followed_by === true) continue;

    await delay(getRandomArbitrary(10, 1000));

    if (typeof user.unfollow === "function") {
      await user.unfollow();
    } else {
      await ig.friendship.destroy(user.id);
    }
    unfollowedPeople.push(user);
    console.log("unfollowed :" + user.username);
  }
  save(unfollowedFile(username), unfollowedPeople);
}

(async () => {
  if (!username || !password) throw new Error("missing env vars: USERNAME, PASSWORD");
  try {
    ig.request.end$.subscribe(async () => {
      const serialized = await ig.state.serialize();
      delete serialized.constants; // this deletes the version info, so you'll always use the version provided by the library
      stateSave(serialized);
    });

    if (stateExists()) {
      await ig.state.deserialize(stateLoad());
    }

    const auth = await tryLogin();
    let following = [];
    if (process.env.IG_USE_FILES === "1") following = await loadFollowingsFromFiles();
    if (following.length === 0) following = await loadFollowings(auth.pk);

    await doUnfollow(following);

    process.exit(0);
  } catch (error) {
    console.error("unhandled error: %o", error);
    process.exit(1);
  }
})();
