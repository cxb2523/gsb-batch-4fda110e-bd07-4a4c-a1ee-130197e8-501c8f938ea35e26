"""Tests for the post-scrape pipeline."""

import copy
import json
import logging
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from modules.pipeline import (
    CleanupTask,
    CustomParamsTask,
    DateTask,
    ImageTask,
    JSONTask,
    MongoDBTask,
    PostScrapeRunner,
    S3Task,
    SyncTask,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _base_config(**overrides):
    cfg = {
        "convert_dates": False,
        "download_images": False,
        "use_s3": False,
        "use_mongodb": False,
        "backup_to_json": False,
        "store_local_paths": True,
        "replace_urls": False,
        "preserve_original_urls": True,
        "custom_params": {},
        "image_dir": "review_images",
        "download_threads": 1,
        "max_width": 800,
        "max_height": 800,
        "json_path": "test_reviews.json",
        "seen_ids_path": "test_reviews.ids",
        "mongodb": {"uri": "mongodb://localhost:27017", "database": "test", "collection": "test", "sync_mode": "update"},
        "s3": {"sync_mode": "update"},
    }
    cfg.update(overrides)
    return cfg


def _sample_reviews():
    return {
        "rev1": {
            "review_id": "rev1",
            "place_id": "place123",
            "author": "Alice",
            "rating": 5,
            "description": {"en": "Great place"},
            "review_date": "2 months ago",
            "created_date": "2026-01-01T00:00:00",
            "last_modified_date": "",
            "user_images": ["https://lh3.googleusercontent.com/img1=w100"],
            "profile_picture": "https://lh3.googleusercontent.com/prof1=s100",
        },
        "rev2": {
            "review_id": "rev2",
            "place_id": "place123",
            "author": "Bob",
            "rating": 3,
            "description": {"en": "Ok"},
            "review_date": "a week ago",
            "created_date": "",
            "last_modified_date": "",
            "user_images": [],
            "profile_picture": "",
        },
    }


# ---------------------------------------------------------------------------
# DateTask
# ---------------------------------------------------------------------------

class TestDateTask:
    def test_disabled_when_convert_dates_false(self):
        task = DateTask(_base_config(convert_dates=False))
        assert not task.enabled

    def test_enabled_when_convert_dates_true(self):
        task = DateTask(_base_config(convert_dates=True))
        assert task.enabled

    def test_run_converts_dates(self):
        task = DateTask(_base_config(convert_dates=True))
        reviews = _sample_reviews()
        task.run(reviews, "place123")
        # review_date should now be a datetime (DateConverter parses relative dates)
        assert isinstance(reviews["rev1"]["review_date"], datetime)


# ---------------------------------------------------------------------------
# ImageTask
# ---------------------------------------------------------------------------

class TestImageTask:
    def test_disabled_when_download_images_false(self):
        task = ImageTask(_base_config(download_images=False))
        assert not task.enabled

    def test_enabled_when_download_images_true(self):
        task = ImageTask(_base_config(download_images=True))
        assert task.enabled

    @patch("modules.pipeline.ImageHandler")
    def test_s3_disabled_in_image_task(self, mock_ih_cls):
        """ImageTask should create ImageHandler with use_s3=False."""
        cfg = _base_config(download_images=True, use_s3=True)
        ImageTask(cfg)
        # ImageHandler should have been called with use_s3=False
        call_kwargs = mock_ih_cls.call_args
        passed_config = call_kwargs[0][0]
        assert passed_config["use_s3"] is False


# ---------------------------------------------------------------------------
# S3Task
# ---------------------------------------------------------------------------

class TestS3Task:
    def test_disabled_when_use_s3_false(self):
        task = S3Task(_base_config(use_s3=False))
        assert not task.enabled

    @patch("modules.pipeline.S3Handler")
    def test_enabled_when_use_s3_and_handler_enabled(self, mock_s3_cls):
        mock_handler = MagicMock()
        mock_handler.enabled = True
        mock_s3_cls.return_value = mock_handler
        task = S3Task(_base_config(use_s3=True))
        assert task.enabled

    @staticmethod
    def _mock_s3_handler(mock_s3_cls, upload_results=None):
        """Build a MagicMock S3Handler with the attributes S3Task reads."""
        mock_handler = MagicMock()
        mock_handler.enabled = True
        mock_handler.prefix = "reviews/"
        mock_handler.profiles_folder = "profiles"
        mock_handler.reviews_folder = "reviews"
        mock_handler.list_existing_keys.return_value = set()
        mock_handler.upload_images_batch.return_value = upload_results or {}
        mock_s3_cls.return_value = mock_handler
        return mock_handler

    @patch("modules.pipeline.S3Handler")
    def test_new_only_skips_existing(self, mock_s3_cls):
        mock_handler = MagicMock()
        mock_handler.enabled = True
        mock_handler.prefix = "reviews/"
        mock_handler.profiles_folder = "profiles"
        mock_handler.reviews_folder = "reviews"
        mock_handler.list_existing_keys.return_value = {"reviews/place123/reviews/img1.jpg"}
        mock_handler.upload_images_batch.return_value = {}
        mock_s3_cls.return_value = mock_handler

        cfg = _base_config(use_s3=True, s3={"sync_mode": "new_only"})
        task = S3Task(cfg)

        reviews = {
            "rev1": {
                "review_id": "rev1",
                "local_images": ["img1.jpg"],
                "user_images": ["https://example.com/img1.jpg"],
            }
        }

        # Create the local file so it would be found
        img_dir = Path("review_images/place123/reviews")
        img_dir.mkdir(parents=True, exist_ok=True)
        (img_dir / "img1.jpg").write_bytes(b"fake")

        try:
            task.run(reviews, "place123")
            # list_existing_keys should have been called
            mock_handler.list_existing_keys.assert_called_once_with("place123")
        finally:
            (img_dir / "img1.jpg").unlink(missing_ok=True)
            # cleanup dirs
            for d in [img_dir, img_dir.parent, img_dir.parent.parent]:
                try:
                    d.rmdir()
                except OSError:
                    pass

    @patch("modules.pipeline.S3Handler")
    def test_backfill_uploads_files_from_previous_batches(self, mock_s3_cls, tmp_path):
        """Files downloaded by earlier scrapes but never uploaded are picked
        up from the place's local image directories when this batch has a
        changed review, even though no review references them."""
        mock_handler = self._mock_s3_handler(mock_s3_cls)
        cfg = _base_config(
            use_s3=True,
            replace_urls=True,
            image_dir=str(tmp_path / "review_images"),
        )
        task = S3Task(cfg)

        # This batch's changed review references img_new.jpg only.
        reviews_dir = tmp_path / "review_images" / "placeA" / "reviews"
        profiles_dir = tmp_path / "review_images" / "placeA" / "profiles"
        reviews_dir.mkdir(parents=True)
        profiles_dir.mkdir(parents=True)
        (reviews_dir / "img_new.jpg").write_bytes(b"new")
        # Orphans from earlier batches — not referenced by any review here.
        (reviews_dir / "img_orphan.jpg").write_bytes(b"orphan")
        (profiles_dir / "prof_orphan.jpg").write_bytes(b"porphan")

        def fake_upload(files_to_upload):
            return {fn: f"https://s3.example.com/{fn}" for fn in files_to_upload}

        mock_handler.upload_images_batch.side_effect = fake_upload

        reviews = {
            "rev1": {
                "review_id": "rev1",
                "local_images": ["img_new.jpg"],
                "local_profile_picture": "",
                "user_images": ["https://lh3.googleusercontent.com/img_new.jpg"],
                "profile_picture": "",
            }
        }
        task.run(reviews, "placeA")

        uploaded = mock_handler.upload_images_batch.call_args.args[0]
        assert set(uploaded) == {"img_new.jpg", "img_orphan.jpg", "prof_orphan.jpg"}
        # Folder classification must survive the backfill scan.
        assert uploaded["img_new.jpg"][1] is False
        assert uploaded["img_orphan.jpg"][1] is False
        assert uploaded["prof_orphan.jpg"][1] is True
        # The changed review's URL is replaced using the upload results.
        assert reviews["rev1"]["user_images"] == [
            "https://s3.example.com/img_new.jpg"
        ]

    @patch("modules.pipeline.S3Handler")
    def test_backfill_does_not_mix_in_other_places(self, mock_s3_cls, tmp_path):
        """The backfill scan is confined to this place's directory — files
        sitting under another place's folder must never be uploaded."""
        mock_handler = self._mock_s3_handler(mock_s3_cls)
        cfg = _base_config(use_s3=True, image_dir=str(tmp_path / "review_images"))
        task = S3Task(cfg)

        place_a = tmp_path / "review_images" / "placeA"
        place_b = tmp_path / "review_images" / "placeB"
        (place_a / "reviews").mkdir(parents=True)
        (place_b / "reviews").mkdir(parents=True)
        (place_b / "profiles").mkdir(parents=True)
        (place_a / "reviews" / "a.jpg").write_bytes(b"a")
        (place_b / "reviews" / "b.jpg").write_bytes(b"b")
        (place_b / "profiles" / "b_prof.jpg").write_bytes(b"bp")

        reviews = {
            "rev1": {"review_id": "rev1", "local_images": ["a.jpg"]},
        }
        task.run(reviews, "placeA")

        uploaded = mock_handler.upload_images_batch.call_args.args[0]
        assert set(uploaded) == {"a.jpg"}

    @patch("modules.pipeline.S3Handler")
    def test_new_only_list_failure_degrades_to_full_upload(
        self, mock_s3_cls, tmp_path, caplog
    ):
        """If list_existing_keys raises, new_only must log a warning and
        upload every local file instead of failing or dropping them."""
        mock_handler = self._mock_s3_handler(mock_s3_cls)
        listing_error = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "denied"}},
            "ListObjectsV2",
        )
        mock_handler.list_existing_keys.side_effect = listing_error
        mock_handler.upload_images_batch.side_effect = lambda files: {
            fn: f"https://s3.example.com/{fn}" for fn in files
        }

        cfg = _base_config(
            use_s3=True,
            replace_urls=True,
            image_dir=str(tmp_path / "review_images"),
            s3={"sync_mode": "new_only"},
        )
        task = S3Task(cfg)

        reviews_dir = tmp_path / "review_images" / "placeA" / "reviews"
        reviews_dir.mkdir(parents=True)
        (reviews_dir / "img1.jpg").write_bytes(b"1")
        (reviews_dir / "img2.jpg").write_bytes(b"2")

        reviews = {
            "rev1": {
                "review_id": "rev1",
                "local_images": ["img1.jpg", "img2.jpg"],
                "user_images": [
                    "https://lh3.googleusercontent.com/img1.jpg",
                    "https://lh3.googleusercontent.com/img2.jpg",
                ],
            }
        }
        with caplog.at_level(logging.WARNING, logger="scraper"):
            task.run(reviews, "placeA")  # must not raise

        # The task did not fail: every local file reached the upload layer,
        # which applies its own dedup/overwrite semantics.
        mock_handler.list_existing_keys.assert_called_once_with("placeA")
        uploaded = mock_handler.upload_images_batch.call_args.args[0]
        assert set(uploaded) == {"img1.jpg", "img2.jpg"}
        assert any(
            "could not list existing keys" in record.message
            and record.levelno == logging.WARNING
            for record in caplog.records
        )
        # Upload results still drive URL replacement on the changed reviews.
        assert reviews["rev1"]["user_images"] == [
            "https://s3.example.com/img1.jpg",
            "https://s3.example.com/img2.jpg",
        ]

    @patch("modules.pipeline.S3Handler")
    def test_no_changed_reviews_skips_without_scanning(
        self, mock_s3_cls, tmp_path, caplog
    ):
        """An empty changed-review batch must skip the task outright — no
        directory scan, no S3 calls (this guards the runner contract inside
        S3Task itself)."""
        mock_handler = self._mock_s3_handler(mock_s3_cls)
        # Another place's files on disk must be left untouched.
        stray_dir = tmp_path / "review_images" / "placeA" / "reviews"
        stray_dir.mkdir(parents=True)
        (stray_dir / "stray.jpg").write_bytes(b"stray")

        cfg = _base_config(use_s3=True, image_dir=str(tmp_path / "review_images"))
        task = S3Task(cfg)

        with caplog.at_level(logging.INFO, logger="scraper"):
            task.run({}, "placeA")

        mock_handler.set_place_id.assert_not_called()
        mock_handler.list_existing_keys.assert_not_called()
        mock_handler.upload_images_batch.assert_not_called()
        assert any(
            "no changed reviews, skipping upload task" in record.message
            for record in caplog.records
        )


# ---------------------------------------------------------------------------
# CleanupTask
# ---------------------------------------------------------------------------

class TestCleanupTask:
    def test_always_enabled(self):
        task = CleanupTask(_base_config())
        assert task.enabled

    def test_strips_local_paths_when_disabled(self):
        task = CleanupTask(_base_config(store_local_paths=False))
        reviews = {
            "r1": {
                "review_id": "r1",
                "local_images": ["img.jpg"],
                "local_profile_picture": "prof.jpg",
            }
        }
        task.run(reviews, "p1")
        assert "local_images" not in reviews["r1"]
        assert "local_profile_picture" not in reviews["r1"]

    def test_strips_originals_when_replace_no_preserve(self):
        task = CleanupTask(_base_config(replace_urls=True, preserve_original_urls=False))
        reviews = {
            "r1": {
                "review_id": "r1",
                "original_image_urls": ["https://example.com/old"],
                "original_profile_picture": "https://example.com/old_prof",
            }
        }
        task.run(reviews, "p1")
        assert "original_image_urls" not in reviews["r1"]
        assert "original_profile_picture" not in reviews["r1"]

    def test_preserves_originals_when_configured(self):
        task = CleanupTask(_base_config(replace_urls=True, preserve_original_urls=True))
        reviews = {
            "r1": {
                "review_id": "r1",
                "original_image_urls": ["url"],
                "original_profile_picture": "url2",
            }
        }
        task.run(reviews, "p1")
        assert "original_image_urls" in reviews["r1"]
        assert "original_profile_picture" in reviews["r1"]


# ---------------------------------------------------------------------------
# CustomParamsTask
# ---------------------------------------------------------------------------

class TestCustomParamsTask:
    def test_disabled_when_empty(self):
        task = CustomParamsTask(_base_config(custom_params={}))
        assert not task.enabled

    def test_enabled_when_params_set(self):
        task = CustomParamsTask(_base_config(custom_params={"company": "Test"}))
        assert task.enabled

    def test_injects_params(self):
        task = CustomParamsTask(_base_config(custom_params={"company": "Acme", "source": "Maps"}))
        reviews = _sample_reviews()
        task.run(reviews, "p1")
        assert reviews["rev1"]["company"] == "Acme"
        assert reviews["rev1"]["source"] == "Maps"
        assert reviews["rev2"]["company"] == "Acme"


# ---------------------------------------------------------------------------
# MongoDBTask
# ---------------------------------------------------------------------------

class TestMongoDBTask:
    def test_disabled_when_use_mongodb_false(self):
        task = MongoDBTask(_base_config(use_mongodb=False))
        assert not task.enabled

    def test_enabled_when_use_mongodb_true(self):
        task = MongoDBTask(_base_config(use_mongodb=True))
        assert task.enabled

    @patch("modules.pipeline.MongoDBStorage" if False else "modules.data_storage.MongoDBStorage")
    def test_run_calls_write_reviews(self, mock_storage_cls):
        mock_storage = MagicMock()
        mock_storage_cls.return_value = mock_storage

        task = MongoDBTask(_base_config(use_mongodb=True))
        reviews = _sample_reviews()

        with patch("modules.data_storage.MongoDBStorage", mock_storage_cls):
            task.run(reviews, "p1")

        mock_storage.write_reviews.assert_called_once()


# ---------------------------------------------------------------------------
# JSONTask
# ---------------------------------------------------------------------------

class TestJSONTask:
    def test_disabled_when_backup_false(self):
        task = JSONTask(_base_config(backup_to_json=False))
        assert not task.enabled

    def test_enabled_when_backup_true(self):
        task = JSONTask(_base_config(backup_to_json=True))
        assert task.enabled

    def test_run_writes_file(self, tmp_path):
        json_file = tmp_path / "out.json"
        cfg = _base_config(backup_to_json=True, json_path=str(json_file))
        task = JSONTask(cfg)
        reviews = {
            "r1": {"review_id": "r1", "author": "Test", "created_date": datetime(2026, 1, 1)},
        }
        task.run(reviews, "p1")
        data = json.loads(json_file.read_text())
        assert len(data) == 1
        assert data[0]["review_id"] == "r1"
        # datetime should be serialized to ISO string
        assert data[0]["created_date"] == "2026-01-01T00:00:00"


# ---------------------------------------------------------------------------
# PostScrapeRunner
# ---------------------------------------------------------------------------

class TestPostScrapeRunner:
    def test_skips_disabled_tasks(self):
        """All tasks disabled → no errors, no mutations."""
        cfg = _base_config()
        runner = PostScrapeRunner(cfg)
        reviews = _sample_reviews()
        original = copy.deepcopy(reviews)
        runner.run(reviews, "p1")
        runner.close()
        # Only CleanupTask runs (always enabled), but with default config it's a no-op
        assert reviews == original

    def test_empty_reviews_noop(self):
        cfg = _base_config()
        runner = PostScrapeRunner(cfg)
        runner.run({}, "p1")  # should not raise
        runner.close()

    def test_task_failure_isolation(self):
        """A failing task should not block subsequent tasks."""
        cfg = _base_config(
            convert_dates=True,
            custom_params={"tag": "test"},
        )
        runner = PostScrapeRunner(cfg)

        # Monkey-patch DateTask to raise
        for task in runner._tasks:
            if task.name == "dates":
                task.run = MagicMock(side_effect=RuntimeError("boom"))
                break

        reviews = _sample_reviews()
        runner.run(reviews, "p1")
        runner.close()

        # CustomParamsTask should still have run despite DateTask failure
        assert reviews["rev1"]["tag"] == "test"

    def test_saves_seen_ids(self, tmp_path):
        ids_file = tmp_path / "seen.ids"
        cfg = _base_config(
            backup_to_json=True,
            json_path=str(tmp_path / "out.json"),
            seen_ids_path=str(ids_file),
        )
        runner = PostScrapeRunner(cfg)
        reviews = _sample_reviews()
        runner.run(reviews, "p1", seen={"rev1", "rev2"})
        runner.close()

        saved = set(ids_file.read_text().splitlines())
        assert saved == {"rev1", "rev2"}

    def test_close_handles_errors(self):
        cfg = _base_config()
        runner = PostScrapeRunner(cfg)
        # Force a close error on one task
        runner._tasks[0].close = MagicMock(side_effect=RuntimeError("close fail"))
        runner.close()  # should not raise

    @patch("modules.pipeline.S3Handler")
    def test_s3_task_skipped_when_no_changed_reviews(self, mock_s3_cls, tmp_path, caplog):
        """With changed_ids set to an empty set, the S3 task is skipped with
        the standard log line and never scans the local image directory."""
        mock_handler = MagicMock()
        mock_handler.enabled = True
        mock_s3_cls.return_value = mock_handler

        # A file exists on disk — it must NOT be uploaded because no review
        # changed this session.
        stray_dir = tmp_path / "review_images" / "p1" / "reviews"
        stray_dir.mkdir(parents=True)
        (stray_dir / "stray.jpg").write_bytes(b"stray")

        cfg = _base_config(
            use_s3=True,
            image_dir=str(tmp_path / "review_images"),
        )
        runner = PostScrapeRunner(cfg)
        runner.set_changed_ids(set())  # explicit empty: nothing changed
        reviews = _sample_reviews()

        with caplog.at_level(logging.INFO, logger="scraper"):
            runner.run(reviews, "p1")
        runner.close()

        mock_handler.upload_images_batch.assert_not_called()
        mock_handler.list_existing_keys.assert_not_called()
        assert any(
            "task 's3' skipped (no changed reviews)" in record.message
            for record in caplog.records
        )

    @patch("modules.pipeline.S3Handler")
    def test_s3_task_runs_when_reviews_changed(self, mock_s3_cls, tmp_path):
        """A non-empty changed set reaches S3Task and triggers the backfill
        scan of this place's local directories."""
        mock_handler = MagicMock()
        mock_handler.enabled = True
        mock_handler.prefix = "reviews/"
        mock_handler.profiles_folder = "profiles"
        mock_handler.reviews_folder = "reviews"
        mock_handler.list_existing_keys.return_value = set()
        mock_handler.upload_images_batch.side_effect = lambda files: {
            fn: f"https://s3.example.com/{fn}" for fn in files
        }
        mock_s3_cls.return_value = mock_handler

        reviews_dir = tmp_path / "review_images" / "p1" / "reviews"
        reviews_dir.mkdir(parents=True)
        # Orphan from a previous batch: not referenced by the changed review,
        # but still inside this place's directory → backfilled.
        (reviews_dir / "orphan.jpg").write_bytes(b"o")
        (reviews_dir / "img1.jpg").write_bytes(b"i")

        cfg = _base_config(
            use_s3=True,
            image_dir=str(tmp_path / "review_images"),
        )
        runner = PostScrapeRunner(cfg)
        runner.set_changed_ids({"rev1"})
        reviews = _sample_reviews()
        reviews["rev1"]["local_images"] = ["img1.jpg"]

        runner.run(reviews, "p1")
        runner.close()

        uploaded = mock_handler.upload_images_batch.call_args.args[0]
        assert set(uploaded) == {"img1.jpg", "orphan.jpg"}
