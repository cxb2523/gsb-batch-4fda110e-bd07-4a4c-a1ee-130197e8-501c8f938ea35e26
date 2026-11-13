# Copyright (c) Microsoft Corporation.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from dataclasses import dataclass
from typing import Optional


class InjectRouteStatus:
    """Stable string constants describing the installation state of the
    Patchright injection route on a ``BrowserContext`` or ``Page``.

    The constants are plain strings so they can be compared directly in
    assertions::

        assert state.status == InjectRouteStatus.INSTALLED
    """

    #: The injection route has never been installed on this object.
    NOT_INSTALLED = "not_installed"
    #: An installation attempt is currently in progress.
    INSTALLING = "installing"
    #: The injection route was mounted successfully.
    INSTALLED = "installed"
    #: The last installation attempt failed; ``error`` holds the reason.
    FAILED = "failed"


@dataclass
class InjectRouteState:
    """Snapshot of the injection route installation state.

    Instances are returned by the (async/sync) ``get_inject_route_state()``
    query methods of ``BrowserContext`` and ``Page``.
    """

    #: One of the :class:`InjectRouteStatus` string constants.
    status: str
    #: Failure reason as a string when ``status`` is ``"failed"``, else ``None``.
    error: Optional[str] = None

    def __iter__(self):
        # Allow ``status, error = await obj.get_inject_route_state()``.
        yield self.status
        yield self.error
