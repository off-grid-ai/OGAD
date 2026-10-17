<?php
// HumHub seed controller (Yii console): builds users, spaces, posts, comments, likes, follows and
// friendships from the JSON plan written by humhub_seed.py, through HumHub's own models.
//   php yii farm-seed /dev/shm/clone-farm/humhub-seed.json <password>
// Registered in protected/config/console.php by farm/humhub/install.sh.

use humhub\modules\comment\models\Comment;
use humhub\modules\content\models\Content;
use humhub\modules\friendship\models\Friendship;
use humhub\modules\like\models\Like;
use humhub\modules\post\models\Post;
use humhub\modules\space\models\Space;
use humhub\modules\user\models\Password;
use humhub\modules\user\models\User;
use yii\console\Controller;

class FarmSeedController extends Controller
{
    private array $users = [];

    private function as(string $nick): User
    {
        $u = $this->users[$nick];
        Yii::$app->user->setIdentity($u);
        return $u;
    }

    public function actionIndex(string $file, string $password)
    {
        $plan = json_decode(file_get_contents($file), true);
        Yii::$app->getModule('friendship')->settings->set('enable', 1);
        $admin = User::findOne(['username' => 'farmadmin']);
        $admin->profile->firstname = 'Farm';
        $admin->profile->lastname = 'Admin';
        $admin->profile->save();
        foreach ($plan['users'] as $p) {
            $u = User::findOne(['username' => $p['username']]) ?? new User();
            $u->username = $p['username'];
            $u->email = $p['email'];
            $u->status = User::STATUS_ENABLED;
            $u->language = '';
            if (!$u->save()) {
                throw new Exception('user ' . json_encode($u->getErrors()));
            }
            $u->profile->firstname = $p['first'];
            $u->profile->lastname = $p['last'];
            $u->profile->title = $p['title'];
            $u->profile->city = $p['city'];
            $u->profile->about = $p['about'];
            $u->profile->save(false);
            $pw = new Password();
            $pw->user_id = $u->id;
            $pw->setPassword($password);
            $pw->save();
            $this->users[$p['username']] = User::findOne($u->id);
        }
        echo "users " . count($this->users) . "\n";
        $spaces = [];
        foreach ($plan['spaces'] as $s) {
            $this->as($s['owner']);
            $space = new Space();
            $space->name = $s['name'];
            $space->description = $s['description'];
            $space->visibility = Space::VISIBILITY_ALL;
            $space->join_policy = Space::JOIN_POLICY_FREE;
            if (!$space->save(false)) {
                throw new Exception('space ' . json_encode($space->getErrors()));
            }
            foreach ($s['members'] as $m) {
                if ($m !== $s['owner']) {
                    $space->addMember($this->users[$m]->id, 1, true);
                }
            }
            $spaces[$s['name']] = $space;
        }
        echo "spaces " . count($spaces) . "\n";
        $n = 0; $nc = 0; $nl = 0;
        foreach ($plan['posts'] as $p) {
            $author = $this->as($p['author']);
            $container = isset($p['space']) ? $spaces[$p['space']] : $author;
            $post = new Post($container, Content::VISIBILITY_PUBLIC);
            $post->message = $p['text'];
            if (!$post->save()) {
                echo 'post failed ' . json_encode($post->getErrors()) . "\n";
                continue;
            }
            $n++;
            foreach ($p['likes'] as $l) {
                $this->as($l);
                $like = new Like(['object_model' => Post::class, 'object_id' => $post->id]);
                if ($like->save()) $nl++;
            }
            foreach ($p['comments'] as $c) {
                $this->as($c['author']);
                $comment = new Comment(['message' => $c['text'], 'object_model' => Post::class, 'object_id' => $post->id]);
                if (!$comment->save()) {
                    echo 'comment failed ' . json_encode($comment->getErrors()) . "\n";
                    continue;
                }
                $nc++;
                foreach ($c['likes'] as $l) {
                    $this->as($l);
                    $like = new Like(['object_model' => Comment::class, 'object_id' => $comment->id]);
                    if ($like->save()) $nl++;
                }
            }
            if ($n % 100 === 0) echo "posts $n\n";
        }
        echo "posts $n comments $nc likes $nl\n";
        foreach ($plan['follows'] as [$a, $b]) {
            $this->users[$b]->follow($this->users[$a]->id, false);
        }
        foreach ($plan['friends'] as [$a, $b]) {
            Friendship::add($this->users[$a], $this->users[$b]);
            Friendship::add($this->users[$b], $this->users[$a]);
        }
        // Pending connection requests to the main persona (X4: accept a request from a named person).
        $me = $this->users[$plan['users'][0]['username']];
        $k = 0;
        foreach (array_slice($plan['users'], 25) as $p) {
            $u = $this->users[$p['username']];
            if (Friendship::getStateForUser($me, $u) === Friendship::STATE_NONE && $k < 6) {
                Friendship::add($u, $me);
                $k++;
            }
        }
        echo "follows " . count($plan['follows']) . " friends " . count($plan['friends']) . " requests $k\n";
    }
}
